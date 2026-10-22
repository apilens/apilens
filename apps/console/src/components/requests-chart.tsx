import type { Deploy, Timeseries } from "@/lib/api";
import { absoluteTime, axisLabel, formatCount, formatMs } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table";

// Stacked bars per bucket, rendered on the server as SVG: no chart library,
// no mount race, crisp at any width. 2xx/3xx are neutral (they are the
// context), 4xx warning and 5xx danger (they are the signal). Deploys are
// thin vertical rules with their release name.

const PLOT_HEIGHT = 176;
const OK_FILL = "color-mix(in oklch, var(--ap-subtle-foreground) 42%, transparent)";

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  // Fine steps keep the tallest bar near the top instead of at half height.
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (v <= m * exp) return m * exp;
  }
  return 10 * exp;
}

export function RequestsChart({ series, deploys }: { series: Timeseries; deploys: Deploy[] }) {
  const points = series.points;
  const n = points.length;
  const first = points[0];
  if (n === 0 || !first) return null;

  const max = niceMax(Math.max(...points.map((p) => p.requests)));
  const start = Date.parse(first.ts);
  const bucketMs = series.bucket_seconds * 1000;
  const end = start + n * bucketMs;
  const y = (v: number) => (v / max) * 100;

  const tickEvery = Math.max(1, Math.ceil(n / 6));
  const xTicks = points.map((p, i) => ({ p, i })).filter(({ i }) => i % tickEvery === 0);

  const markers = deploys
    .map((d) => ({ d, t: Date.parse(d.deployed_at) }))
    .filter(({ t }) => t >= start && t <= end)
    .map(({ d, t }) => ({ d, x: ((t - start) / bucketMs / n) * 100 }))
    .sort((a, b) => a.x - b.x)
    .map((m, i, all) => {
      // Labels closer than ~9% of the width would overlap: drop to a second row.
      const prev = all[i - 1];
      const row = prev && m.x - prev.x < 9 && i % 2 === 1 ? 1 : 0;
      return { ...m, row, alignRight: m.x > 88 };
    });

  return (
    <div className="px-4 pt-4 pb-3">
      <div className="grid grid-cols-[3rem_1fr] gap-x-2">
        <div className="relative" style={{ height: PLOT_HEIGHT }} aria-hidden>
          {[max, max / 2, 0].map((v, i) => (
            <span
              key={v}
              className="absolute right-0 -translate-y-1/2 text-2xs text-subtle-foreground tabular-nums"
              style={{ top: `${i * 50}%` }}
            >
              {formatCount(v)}
            </span>
          ))}
        </div>

        <div className="relative" style={{ height: PLOT_HEIGHT }}>
          <svg
            viewBox={`0 0 ${n} 100`}
            preserveAspectRatio="none"
            className="absolute inset-0 size-full overflow-visible"
            role="img"
            aria-label={`Requests per ${series.bucket_seconds / 60} minute bucket, split by status class`}
          >
            {[0, 50, 100].map((gy) => (
              <line key={gy} x1={0} x2={n} y1={gy} y2={gy} stroke="var(--ap-chart-grid)" vectorEffect="non-scaling-stroke" />
            ))}
            {points.map((p, i) => {
              const ok = Math.max(0, p.requests - p.client_errors - p.server_errors);
              const hOk = y(ok);
              const hClient = y(p.client_errors);
              const hServer = y(p.server_errors);
              const x = i + 0.14;
              const w = 0.72;
              return (
                <g key={p.ts}>
                  <title>
                    {`${absoluteTime(p.ts)} · ${formatCount(p.requests)} requests · ${formatCount(p.client_errors)} client errors · ${formatCount(p.server_errors)} server errors · p95 ${formatMs(p.p95_ms)}`}
                  </title>
                  <rect x={i} y={0} width={1} height={100} fill="transparent" />
                  {hOk > 0 ? <rect x={x} y={100 - hOk} width={w} height={hOk} style={{ fill: OK_FILL }} /> : null}
                  {hClient > 0 ? <rect x={x} y={100 - hOk - hClient} width={w} height={hClient} style={{ fill: "var(--ap-warning)" }} /> : null}
                  {hServer > 0 ? (
                    <rect x={x} y={100 - hOk - hClient - hServer} width={w} height={hServer} style={{ fill: "var(--ap-danger)" }} />
                  ) : null}
                </g>
              );
            })}
            {markers.map(({ d, x }) => (
              <line
                key={d.deployed_at + d.release}
                x1={(x / 100) * n}
                x2={(x / 100) * n}
                y1={0}
                y2={100}
                stroke="var(--ap-muted-foreground)"
                strokeDasharray="3 3"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </svg>
          {markers.map(({ d, x, row, alignRight }) => (
            <span
              key={`label-${d.deployed_at}${d.release}`}
              className={`absolute rounded-sm bg-card px-1 font-mono text-2xs whitespace-nowrap text-muted-foreground ${alignRight ? "-translate-x-full -ml-1" : "ml-1"}`}
              style={{ left: `${x}%`, top: row ? 14 : -2 }}
              title={`Deployed ${d.release}${d.commit ? ` (${d.commit})` : ""} at ${absoluteTime(d.deployed_at)}`}
            >
              {d.release}
            </span>
          ))}
        </div>

        <div />
        <div className="relative mt-1.5 h-4" aria-hidden>
          {xTicks.map(({ p, i }) => (
            <span
              key={p.ts}
              className="absolute -translate-x-1/2 text-2xs whitespace-nowrap text-subtle-foreground tabular-nums"
              style={{ left: `${((i + 0.5) / n) * 100}%` }}
            >
              {axisLabel(p.ts, series.bucket_seconds)}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <Legend swatch={<span className="size-2.5 rounded-sm" style={{ background: OK_FILL }} />} label="2xx and 3xx" />
        <Legend swatch={<span className="size-2.5 rounded-sm bg-warning" />} label="4xx client errors" />
        <Legend swatch={<span className="size-2.5 rounded-sm bg-danger" />} label="5xx server errors" />
        {markers.length ? <Legend swatch={<span className="h-3 w-0 border-l border-dashed border-muted-foreground" />} label="Deploy" /> : null}
        <span className="ml-auto text-subtle-foreground">UTC · one bar per {bucketLabel(series.bucket_seconds)}</span>
      </div>

      <details className="mt-3 border-t border-border pt-2">
        <summary className="focus-ring inline-block cursor-pointer rounded-sm text-xs text-muted-foreground hover:text-foreground">
          View as table
        </summary>
        <div className="mt-2 max-h-72 overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Bucket start</TableHead>
                <TableHead numeric>Requests</TableHead>
                <TableHead numeric>4xx</TableHead>
                <TableHead numeric>5xx</TableHead>
                <TableHead numeric>p95</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {points.map((p) => (
                <TableRow key={p.ts}>
                  <TableCell mono>{absoluteTime(p.ts)}</TableCell>
                  <TableCell numeric>{formatCount(p.requests)}</TableCell>
                  <TableCell numeric tone={p.client_errors ? "warning" : "muted"}>
                    {formatCount(p.client_errors)}
                  </TableCell>
                  <TableCell numeric tone={p.server_errors ? "danger" : "muted"}>
                    {formatCount(p.server_errors)}
                  </TableCell>
                  <TableCell numeric>{p.requests ? formatMs(p.p95_ms) : "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </details>
    </div>
  );
}

function Legend({ swatch, label }: { swatch: React.ReactNode; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {swatch}
      {label}
    </span>
  );
}

function bucketLabel(seconds: number): string {
  if (seconds % 3600 === 0) return seconds === 3600 ? "hour" : `${seconds / 3600} hours`;
  if (seconds % 60 === 0) return seconds === 60 ? "minute" : `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}
