import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiLensClient } from "../src/client.js";
import { COMMIT_ENV_VARS, detectCommit, detectRelease } from "../src/release.js";

const ALL_VARS = ["APILENS_RELEASE", ...COMMIT_ENV_VARS];

function clearReleaseEnv(): void {
  for (const name of ALL_VARS) {
    vi.stubEnv(name, "");
  }
}

function makeClient(config: { release?: string; commit?: string } = {}) {
  const bodies: string[] = [];
  const client = new ApiLensClient({
    apiKey: "test",
    appId: "test",
    batchSize: 10,
    fetchImpl: async (_url, options) => {
      bodies.push(String(options?.body || ""));
      return new Response(null, { status: 200 });
    },
    ...config,
  });
  client.stop();
  return { client, bodies };
}

async function sentRecords(config: { release?: string; commit?: string } = {}) {
  const { client, bodies } = makeClient(config);
  client.capture({ method: "GET", path: "/x", status_code: 200, response_time_ms: 1 });
  await client.flushAll();
  return JSON.parse(bodies[0]).requests as Array<Record<string, unknown>>;
}

beforeEach(() => {
  clearReleaseEnv();
});

afterEach(async () => {
  await ApiLensClient.shutdown();
  vi.unstubAllEnvs();
});

describe("release/commit detection", () => {
  it("reads release from APILENS_RELEASE", () => {
    vi.stubEnv("APILENS_RELEASE", " v1.2.3 ");
    expect(detectRelease()).toBe("v1.2.3");
  });

  it.each(COMMIT_ENV_VARS.map((name) => [name]))("reads commit from %s", (name) => {
    vi.stubEnv(name, `sha-${name}`);
    expect(detectCommit()).toBe(`sha-${name}`);
  });

  it("prefers sources in Python SDK order, then Vercel, then Heroku", () => {
    vi.stubEnv("HEROKU_SLUG_COMMIT", "heroku");
    expect(detectCommit()).toBe("heroku");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "vercel");
    expect(detectCommit()).toBe("vercel");
    vi.stubEnv("RENDER_GIT_COMMIT", "render");
    expect(detectCommit()).toBe("render");
    vi.stubEnv("SOURCE_VERSION", "source");
    expect(detectCommit()).toBe("source");
    vi.stubEnv("GIT_COMMIT", "git");
    expect(detectCommit()).toBe("git");
    vi.stubEnv("APILENS_COMMIT", "explicit");
    expect(detectCommit()).toBe("explicit");
  });

  it("skips blank values and returns empty when nothing is set", () => {
    expect(detectRelease()).toBe("");
    expect(detectCommit()).toBe("");
    vi.stubEnv("APILENS_COMMIT", "   ");
    vi.stubEnv("GIT_COMMIT", "abc123");
    expect(detectCommit()).toBe("abc123");
  });

  it("accepts an explicit env map", () => {
    expect(detectCommit({ VERCEL_GIT_COMMIT_SHA: "v" })).toBe("v");
    expect(detectRelease({ APILENS_RELEASE: "r" })).toBe("r");
  });
});

describe("release/commit stamping", () => {
  it("sends empty release/commit fields when nothing is configured", async () => {
    const [record] = await sentRecords();
    expect(record.release).toBe("");
    expect(record.commit).toBe("");
  });

  it("stamps env-detected release/commit on every record", async () => {
    vi.stubEnv("APILENS_RELEASE", "2026.11.05");
    vi.stubEnv("HEROKU_SLUG_COMMIT", "deadbeef");
    const [record] = await sentRecords();
    expect(record.release).toBe("2026.11.05");
    expect(record.commit).toBe("deadbeef");
  });

  it("explicit config wins over the environment", async () => {
    vi.stubEnv("APILENS_RELEASE", "env-release");
    vi.stubEnv("GIT_COMMIT", "env-commit");
    const [record] = await sentRecords({ release: "cfg-release", commit: "cfg-commit" });
    expect(record.release).toBe("cfg-release");
    expect(record.commit).toBe("cfg-commit");
  });

  it("keeps per-record values and fills records built without them", async () => {
    const { client, bodies } = makeClient({ release: "cfg", commit: "c0ffee" });
    client.capture({
      method: "GET",
      path: "/a",
      status_code: 200,
      response_time_ms: 1,
      release: "old",
      commit: "0ld",
    });
    client.captureMany([{ method: "GET", path: "/b", status_code: 200, response_time_ms: 1 }]);
    const { release: _r, commit: _c, ...bare } = client.queue[0];
    client.captureRecord({ ...bare, release: "", commit: "", path: "/c" });
    await client.flushAll();

    const records = JSON.parse(bodies[0]).requests;
    expect(records.map((r: Record<string, unknown>) => [r.path, r.release, r.commit])).toEqual([
      ["/a", "old", "0ld"],
      ["/b", "cfg", "c0ffee"],
      ["/c", "cfg", "c0ffee"],
    ]);
  });
});
