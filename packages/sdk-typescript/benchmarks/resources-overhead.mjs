// Cost of the runtime-resources sampler (M7, D11): resources on vs off.
//
// 1. CPU per sample. A ResourceSampler with the default collectors (no
//    timers) is sampled SAMPLES times. Its clocks advance 60 s per sample, so
//    every sample also runs the 60 s collectors (PSS, heap spaces, the process
//    list): the worst case. CPU is process.cpuUsage() (user + system) around
//    each sampleNow(); the main thread is the only busy thread, so this is the
//    sampler's cost. The share of a core is the mean over the production
//    interval (15 s).
// 2. Request latency. A node:http echo server in this process answers
//    keep-alive requests from this process, first with no sampler, then with
//    a sampler on the same event loop sampling every STRESS_MS (100 ms, 150x
//    production), so every sample's event-loop time lands on requests.
//
// Thresholds (#1139): a median CPU per worst-case sample over --max-sample-ms
// (1 ms), or a mean share over --max-core-pct (0.1 % of one core at 15 s),
// exits 1. The median, not p95: a noisy neighbour on a shared runner moves the
// tail (p95 and max are reported). process.cpuUsage() also counts V8's GC and
// libuv threads, so the TS number is an upper bound. The
// latency delta is reported, never gated (too noisy on shared runners).
//
// Usage (from packages/sdk-typescript, after pnpm install):
//   node benchmarks/resources-overhead.mjs --output resources-overhead.md --json resources-overhead.json

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const INTERVAL_S = 15;
const SLOW_EVERY_MS = 60_000;

const { values: args } = parseArgs({
  options: {
    samples: { type: "string", default: "300" },
    warmup: { type: "string", default: "20" },
    iterations: { type: "string", default: "6000" },
    rounds: { type: "string", default: "6" },
    "stress-ms": { type: "string", default: "100" },
    "max-sample-ms": { type: "string", default: "1" },
    "max-core-pct": { type: "string", default: "0.1" },
    output: { type: "string" },
    json: { type: "string" },
    bundle: { type: "string" },
    "bundle-only": { type: "string" },
  },
});

// Bundle src/resources once (esbuild, as tsup does) so plain node runs it.
// --bundle <file> runs a bundle made elsewhere (e.g. on the host, for a
// container without the dev toolchain): `--bundle-only <file>` writes one.
const dir = mkdtempSync(join(tmpdir(), "apilens-resources-bench-"));
let bundle = args.bundle;
if (!bundle) {
  const esbuild = createRequire(realpathSync(join(pkg, "node_modules/tsup/package.json")))("esbuild");
  bundle = args["bundle-only"] ?? join(dir, "resources.mjs");
  esbuild.buildSync({
    entryPoints: [join(pkg, "src/resources/index.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: bundle,
    logLevel: "silent",
  });
  if (args["bundle-only"]) {
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  }
}
const { ResourceSampler } = await import(pathToFileURL(bundle).href);
let version = "unknown";
try {
  ({ version } = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")));
} catch {
  // A bundle run outside the package.
}

const pct = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
};

function sampleCosts(samples, warmup) {
  let mono = 1_000;
  let wall = Date.now();
  const sampler = new ResourceSampler({
    intervalMs: SLOW_EVERY_MS,
    timers: false,
    now: () => mono,
    wallNow: () => wall,
    env: process.env,
  });
  const costs = [];
  for (let i = 0; i < warmup + samples; i += 1) {
    mono += SLOW_EVERY_MS;
    wall += SLOW_EVERY_MS;
    const t0 = process.cpuUsage();
    sampler.sampleNow();
    const d = process.cpuUsage(t0);
    if (i >= warmup) {
      costs.push(d.user + d.system);
    }
  }
  const block = sampler.drain();
  return { costs, block };
}

async function requestLatency(iterations, rounds, stressMs) {
  const body = JSON.stringify({ pad: "x".repeat(1000) });
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(parsed));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const once = () =>
    new Promise((resolve, reject) => {
      const t0 = process.hrtime.bigint();
      const req = http.request(
        { host: "127.0.0.1", port, path: "/echo", method: "POST", agent, headers: { "content-type": "application/json" } },
        (res) => {
          res.resume();
          res.on("end", () => resolve(Number(process.hrtime.bigint() - t0) / 1e6));
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  const run = async (n, out) => {
    for (let i = 0; i < n; i += 1) {
      out.push(await once());
    }
  };
  const sampler = new ResourceSampler({ timers: false, env: process.env });
  const off = [];
  const on = [];
  await run(500, []);
  const per = Math.max(1, Math.floor(iterations / rounds));
  // Interleave off/on rounds so drift hits both alike.
  for (let r = 0; r < rounds; r += 1) {
    await run(per, off);
    const timer = setInterval(() => sampler.sampleNow(), stressMs);
    await run(per, on);
    clearInterval(timer);
  }
  agent.destroy();
  await new Promise((resolve) => server.close(resolve));
  const summary = (v) => ({ p50_ms: pct(v, 0.5), p95_ms: pct(v, 0.95), p99_ms: pct(v, 0.99) });
  const result = { off: summary(off), on: summary(on) };
  result.added = Object.fromEntries(Object.keys(result.off).map((k) => [k, result.on[k] - result.off[k]]));
  return result;
}

const { costs, block } = sampleCosts(Number(args.samples), Number(args.warmup));
const mean = costs.reduce((a, b) => a + b, 0) / costs.length;
const result = {
  sdk: "typescript",
  sdk_version: version,
  runtime: `node ${process.versions.node}`,
  platform: `${process.platform} ${process.arch}`,
  limit_source: block?.limit_source ?? null,
  capabilities: block?.capabilities ?? [],
  sample_cpu_us: { p50: pct(costs, 0.5), p95: pct(costs, 0.95), max: Math.max(...costs), mean },
  core_pct_at_15s: (mean / (INTERVAL_S * 1e6)) * 100,
  latency_ms: await requestLatency(Number(args.iterations), Number(args.rounds), Number(args["stress-ms"])),
  stress_interval_s: Number(args["stress-ms"]) / 1000,
};
const breaches = [];
if (result.sample_cpu_us.p50 > Number(args["max-sample-ms"]) * 1000) {
  breaches.push(`median CPU per sample ${result.sample_cpu_us.p50.toFixed(0)} us > ${args["max-sample-ms"]} ms`);
}
if (result.core_pct_at_15s > Number(args["max-core-pct"])) {
  breaches.push(`sampler share ${result.core_pct_at_15s.toFixed(4)} % of a core > ${args["max-core-pct"]} %`);
}
result.breaches = breaches;

const f3 = (v) => `${v.toFixed(3)} ms`;
const s3 = (v) => `${v >= 0 ? "+" : ""}${v.toFixed(3)} ms`;
const s = result.sample_cpu_us;
const lat = result.latency_ms;
const table = [
  `### TypeScript SDK resources sampler (${result.runtime}, ${result.platform}, limit_source ${result.limit_source})`,
  "",
  "| CPU per sample p50 | p95 | max | share of a core at 15 s |",
  "|---|---|---|---|",
  `| ${s.p50.toFixed(0)} us | ${s.p95.toFixed(0)} us | ${s.max.toFixed(0)} us | ${result.core_pct_at_15s.toFixed(4)} % |`,
  "",
  `Request latency, sampler every ${Number(args["stress-ms"])} ms (150x production) vs off:`,
  "",
  "| | p50 | p95 | p99 |",
  "|---|---|---|---|",
  `| off | ${f3(lat.off.p50_ms)} | ${f3(lat.off.p95_ms)} | ${f3(lat.off.p99_ms)} |`,
  `| on | ${f3(lat.on.p50_ms)} | ${f3(lat.on.p95_ms)} | ${f3(lat.on.p99_ms)} |`,
  `| added | ${s3(lat.added.p50_ms)} | ${s3(lat.added.p95_ms)} | ${s3(lat.added.p99_ms)} |`,
  "",
].join("\n");
console.log(table);
if (args.output) {
  writeFileSync(args.output, table);
}
if (args.json) {
  writeFileSync(args.json, `${JSON.stringify(result, null, 2)}\n`);
}
rmSync(dir, { recursive: true, force: true });
for (const b of breaches) {
  console.error(`${process.env.GITHUB_ACTIONS ? "::error::" : "FAIL "}resources sampler over budget: ${b}`);
}
process.exitCode = breaches.length > 0 ? 1 : 0;
