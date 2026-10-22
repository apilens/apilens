import Link from "next/link";
import type { Metadata } from "next";

import { MethodBadge } from "@/components/badge";
import { Filters } from "@/components/filters";
import { PageHeader, StatRow, StatTile } from "@/components/page";
import { Panel, PanelHeader } from "@/components/panel";
import { RequestsChart } from "@/components/requests-chart";
import { ApiErrorState, EmptyState } from "@/components/states";
import { Empty, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/table";
import { api, settle } from "@/lib/api";
import { formatCount, formatMs, formatPercent, formatRate } from "@/lib/format";
import { hrefWith, parseEnv, parseRange, rangeLong, type SearchParams } from "@/lib/params";

export const metadata: Metadata = { title: "Traffic" };

// Tint only threshold breaches: color marks a problem, not every number.
function rateTone(rate: number): "danger" | "warning" | "default" | "muted" {
  if (rate >= 0.05) return "danger";
  if (rate >= 0.01) return "warning";
  return rate > 0 ? "default" : "muted";
}

export default async function TrafficPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const range = parseRange(sp);
  const env = parseEnv(sp);
  const filters = { range, env };

  const [project, summary, series, endpoints, deploys] = await Promise.all([
    settle(api.project()),
    settle(api.summary(filters)),
    settle(api.timeseries(filters)),
    settle(api.endpoints(filters)),
    settle(api.deploys({ range })),
  ]);
  const envs = project.ok ? project.data.environments : [];
  const scope = `${env ?? "All environments"} · ${rangeLong(range)}`;

  const header = (
    <PageHeader title="Traffic" description={scope} actions={<Filters pathname="/traffic" current={filters} envs={envs} />} />
  );

  const failed = [summary, series, endpoints].find((r) => !r.ok);
  if (failed && !failed.ok) {
    return (
      <>
        {header}
        <ApiErrorState error={failed.error} />
      </>
    );
  }
  if (!summary.ok || !series.ok || !endpoints.ok) return header; // narrowed above

  const s = summary.data;
  const hasData = s.requests > 0;
  const empty = (
    <EmptyState title={`No requests in the ${rangeLong(range)}`} action={{ href: "/setup", label: "Connect an app" }}>
      Send traffic with an SDK or an OpenTelemetry exporter and it appears here within a second.
    </EmptyState>
  );

  return (
    <>
      {header}
      <div className="flex flex-col gap-4">
        <StatRow>
          <StatTile label="Requests" value={formatCount(s.requests)} sub={formatRate(s.requests_per_minute)} />
          <StatTile
            label="Error rate"
            value={formatPercent(s.error_rate)}
            sub={
              <>
                <span className={s.client_errors ? "text-warning" : undefined}>{formatCount(s.client_errors)} client</span>
                {" · "}
                <span className={s.server_errors ? "text-danger" : undefined}>{formatCount(s.server_errors)} server</span>
              </>
            }
          />
          <StatTile label="Latency p50" value={hasData ? formatMs(s.p50_ms) : "—"} sub="median response time" />
          <StatTile label="Latency p95" value={hasData ? formatMs(s.p95_ms) : "—"} sub={hasData ? `p99 ${formatMs(s.p99_ms)}` : undefined} />
        </StatRow>

        <Panel>
          <PanelHeader title="Requests over time" description="Stacked by status class" />
          {hasData ? <RequestsChart series={series.data} deploys={deploys.ok ? deploys.data.deploys : []} /> : empty}
        </Panel>

        <Panel>
          <PanelHeader
            title="Endpoints"
            description={hasData ? `${endpoints.data.endpoints.length} routes, busiest first` : undefined}
          />
          {endpoints.data.endpoints.length === 0 ? (
            empty
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20">Method</TableHead>
                  <TableHead>Route</TableHead>
                  <TableHead numeric>Requests</TableHead>
                  <TableHead numeric>4xx</TableHead>
                  <TableHead numeric>5xx</TableHead>
                  <TableHead numeric>Error rate</TableHead>
                  <TableHead numeric>p50</TableHead>
                  <TableHead numeric>p95</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {endpoints.data.endpoints.map((e) => (
                  <TableRow key={`${e.method} ${e.path}`}>
                    <TableCell>
                      <MethodBadge method={e.method} />
                    </TableCell>
                    <TableCell mono className="max-w-md truncate">
                      <Link
                        href={hrefWith("/requests", filters, { path: e.path })}
                        className="focus-ring rounded-sm text-foreground hover:text-brand-text hover:underline underline-offset-4"
                      >
                        {e.path}
                      </Link>
                    </TableCell>
                    <TableCell numeric>{formatCount(e.requests)}</TableCell>
                    <TableCell numeric tone={e.client_errors ? "default" : "muted"}>
                      {e.client_errors ? formatCount(e.client_errors) : <Empty />}
                    </TableCell>
                    <TableCell numeric tone={e.server_errors ? "danger" : "muted"}>
                      {e.server_errors ? formatCount(e.server_errors) : <Empty />}
                    </TableCell>
                    <TableCell numeric tone={rateTone(e.error_rate)}>
                      {formatPercent(e.error_rate)}
                    </TableCell>
                    <TableCell numeric>{formatMs(e.p50_ms)}</TableCell>
                    <TableCell numeric tone={e.p95_ms >= 1000 ? "warning" : "default"}>
                      {formatMs(e.p95_ms)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Panel>
      </div>
    </>
  );
}
