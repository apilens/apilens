import Link from "next/link";
import type { Metadata } from "next";

import { MethodBadge, StatusCode } from "@/components/badge";
import { Filters } from "@/components/filters";
import { CloseIcon } from "@/components/icons";
import { PageHeader, Segmented } from "@/components/page";
import { Panel, PanelHeader } from "@/components/panel";
import { ApiErrorState, EmptyState } from "@/components/states";
import { Empty, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/table";
import { api, settle } from "@/lib/api";
import { absoluteTime, formatMs, relativeTime } from "@/lib/format";
import { hrefWith, parseEnv, parsePath, parseRange, parseStatus, rangeLong, STATUS_CLASSES, type SearchParams } from "@/lib/params";

export const metadata: Metadata = { title: "Requests" };

export default async function RequestsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const range = parseRange(sp);
  const env = parseEnv(sp);
  const status = parseStatus(sp);
  const path = parsePath(sp);
  const current = { range, env, status, path };

  const [project, result] = await Promise.all([settle(api.project()), settle(api.requests(current))]);
  const envs = project.ok ? project.data.environments : [];

  return (
    <>
      <PageHeader
        title="Requests"
        description={`Newest first · ${env ?? "All environments"} · ${rangeLong(range)}`}
        actions={<Filters pathname="/requests" current={current} envs={envs} />}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmented
          label="Status class"
          items={STATUS_CLASSES.map((s) => ({
            key: s.value,
            label: s.label,
            href: hrefWith("/requests", current, { status: s.value }),
            active: s.value === status,
          }))}
        />
        {path ? (
          <span className="inline-flex h-8 items-center gap-1 rounded-md bg-card pr-1 pl-2.5 text-sm shadow-control">
            <span className="text-muted-foreground">Route</span>
            <span className="font-mono text-xs text-foreground">{path}</span>
            <Link
              href={hrefWith("/requests", current, { path: undefined })}
              aria-label="Clear route filter"
              className="focus-ring ml-1 inline-flex size-6 items-center justify-center rounded-sm text-subtle-foreground hover:bg-muted hover:text-foreground"
            >
              <CloseIcon className="size-3.5" />
            </Link>
          </span>
        ) : null}
      </div>

      {!result.ok ? (
        <ApiErrorState error={result.error} />
      ) : (
        <Panel>
          <PanelHeader
            title="Request log"
            description={result.data.requests.length === 100 ? "Showing the latest 100" : `${result.data.requests.length} requests`}
          />
          {result.data.requests.length === 0 ? (
            <EmptyState
              title={`No ${status === "all" ? "" : `${status} `}requests in the ${rangeLong(range)}`}
              action={status !== "all" || path ? { href: hrefWith("/requests", { range, env }, {}), label: "Clear filters" } : { href: "/setup", label: "Connect an app" }}
            >
              {status !== "all" || path ? "Nothing matches the current filters." : "Send traffic with an SDK or an OpenTelemetry exporter."}
            </EmptyState>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-24">Time</TableHead>
                  <TableHead className="w-20">Method</TableHead>
                  <TableHead>Path</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead numeric>Duration</TableHead>
                  <TableHead>Consumer</TableHead>
                  <TableHead>Environment</TableHead>
                  <TableHead>Trace</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.data.requests.map((r, i) => (
                  <TableRow key={`${r.timestamp}-${i}`}>
                    <TableCell tone="muted" className="tabular-nums" title={absoluteTime(r.timestamp)}>
                      {relativeTime(r.timestamp)}
                    </TableCell>
                    <TableCell>
                      <MethodBadge method={r.method} />
                    </TableCell>
                    <TableCell className="max-w-md">
                      <div className="truncate font-mono text-xs text-foreground" title={r.raw_path || r.path}>
                        {r.raw_path || r.path}
                      </div>
                      {r.raw_path && r.raw_path !== r.path ? (
                        <div className="truncate font-mono text-2xs text-subtle-foreground">{r.path}</div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <StatusCode code={r.status_code} />
                    </TableCell>
                    <TableCell numeric tone={r.response_time_ms >= 1000 ? "warning" : "default"}>
                      {formatMs(r.response_time_ms)}
                    </TableCell>
                    <TableCell className="max-w-40 truncate">{r.consumer_name || r.consumer_id || <Empty />}</TableCell>
                    <TableCell tone="muted">{r.environment}</TableCell>
                    <TableCell mono>
                      {r.trace_id ? (
                        <Link
                          href={`/traces/${r.trace_id}`}
                          className="focus-ring rounded-sm text-brand-text underline-offset-4 hover:underline"
                          title={r.trace_id}
                        >
                          {r.trace_id.slice(0, 8)}
                        </Link>
                      ) : (
                        <Empty />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Panel>
      )}
    </>
  );
}
