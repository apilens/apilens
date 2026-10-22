import Link from "next/link";
import type { Metadata } from "next";

import { Badge } from "@/components/badge";
import { CopyButton } from "@/components/client";
import { PageHeader, StatRow, StatTile } from "@/components/page";
import { Panel, PanelHeader } from "@/components/panel";
import { ApiErrorState, EmptyState } from "@/components/states";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/table";
import { api, settle, type Span } from "@/lib/api";
import { absoluteTime, clockTime, formatCount, formatMs } from "@/lib/format";
import { cn } from "@/lib/cn";
import { levelTone } from "@/lib/status";

export const metadata: Metadata = { title: "Trace" };

interface Row {
  span: Span;
  depth: number;
  offsetMs: number;
}

/** Parent-first order; children by start time; orphans become roots. */
function layout(spans: Span[]): { rows: Row[]; startMs: number; totalMs: number } {
  const starts = spans.map((s) => Date.parse(s.start));
  const startMs = Math.min(...starts);
  const endMs = Math.max(...spans.map((s, i) => (starts[i] ?? startMs) + s.duration_ms));
  const ids = new Set(spans.map((s) => s.span_id));
  const children = new Map<string, Span[]>();
  const roots: Span[] = [];
  for (const s of spans) {
    if (s.parent_span_id && ids.has(s.parent_span_id)) {
      const list = children.get(s.parent_span_id) ?? [];
      list.push(s);
      children.set(s.parent_span_id, list);
    } else {
      roots.push(s);
    }
  }
  const byStart = (a: Span, b: Span) => Date.parse(a.start) - Date.parse(b.start);
  const rows: Row[] = [];
  const visit = (s: Span, depth: number) => {
    rows.push({ span: s, depth, offsetMs: Date.parse(s.start) - startMs });
    for (const c of (children.get(s.span_id) ?? []).sort(byStart)) visit(c, Math.min(depth + 1, 8));
  };
  for (const r of roots.sort(byStart)) visit(r, 0);
  return { rows, startMs, totalMs: Math.max(endMs - startMs, 0.001) };
}

export default async function TracePage({ params }: { params: Promise<{ traceId: string }> }) {
  const { traceId } = await params;
  const result = await settle(api.trace(traceId));

  const header = (
    <PageHeader
      title="Trace"
      meta={
        <span className="inline-flex items-center gap-1">
          <span className="font-mono text-xs text-muted-foreground">{traceId}</span>
          <CopyButton value={traceId} label="Copy ID" />
        </span>
      }
    />
  );

  if (!result.ok) {
    return (
      <>
        {header}
        {result.error.kind === "not_found" ? (
          <Panel>
            <EmptyState title="No spans or logs for this trace" action={{ href: "/requests", label: "Back to requests" }}>
              Spans are kept for 30 days. Check that the ID is complete, or that the service sent spans for this trace.
            </EmptyState>
          </Panel>
        ) : (
          <ApiErrorState error={result.error} />
        )}
      </>
    );
  }

  const { spans, logs } = result.data;
  const { rows, startMs, totalMs } = spans.length ? layout(spans) : { rows: [], startMs: 0, totalMs: 0 };
  const services = new Set(spans.map((s) => s.service_name).filter(Boolean));
  const errors = spans.filter((s) => s.status === "error").length;

  return (
    <>
      {header}
      <div className="flex flex-col gap-4">
        <StatRow>
          <StatTile label="Duration" value={spans.length ? formatMs(totalMs) : "—"} sub={spans.length ? `started ${absoluteTime(new Date(startMs).toISOString())}` : undefined} />
          <StatTile label="Spans" value={formatCount(spans.length)} />
          <StatTile label="Services" value={formatCount(services.size)} sub={[...services].slice(0, 3).join(", ") || undefined} />
          <StatTile
            label="Errors"
            value={formatCount(errors)}
            sub={errors ? <span className="text-danger">{errors === 1 ? "1 span failed" : `${errors} spans failed`}</span> : "no failed spans"}
          />
        </StatRow>

        <Panel>
          <PanelHeader title="Waterfall" description="Offsets relative to the first span" />
          {rows.length === 0 ? (
            <EmptyState title="This trace has logs but no spans" />
          ) : (
            <div className="overflow-x-auto">
              <div className="min-w-[720px]">
                <div className="grid h-8 grid-cols-[minmax(220px,2fr)_minmax(240px,3fr)_5.5rem] items-center border-b border-border px-4 text-xs font-medium text-subtle-foreground">
                  <span>Span</span>
                  <span className="flex justify-between tabular-nums">
                    <span>0 ms</span>
                    <span>{formatMs(totalMs / 2)}</span>
                    <span>{formatMs(totalMs)}</span>
                  </span>
                  <span className="text-right">Duration</span>
                </div>
                <ul>
                  {rows.map(({ span, depth, offsetMs }) => {
                    const left = (offsetMs / totalMs) * 100;
                    const width = Math.max((span.duration_ms / totalMs) * 100, 0.4);
                    const failed = span.status === "error";
                    return (
                      <li
                        key={span.span_id}
                        className="grid min-h-9 grid-cols-[minmax(220px,2fr)_minmax(240px,3fr)_5.5rem] items-center border-b border-border px-4 last:border-0 hover:bg-muted/60"
                      >
                        <div className="flex min-w-0 items-center gap-2 py-1.5" style={{ paddingLeft: depth * 14 }}>
                          {depth > 0 ? <span aria-hidden className="h-3 w-2 shrink-0 border-b border-l border-border" /> : null}
                          <div className="min-w-0">
                            <p className={cn("truncate text-sm", failed ? "text-danger" : "text-foreground")} title={span.name}>
                              {span.name || "unnamed span"}
                            </p>
                            <p className="truncate text-2xs text-subtle-foreground">
                              {span.service_name || "unknown service"} · {span.kind}
                              {span.status_code ? ` · ${span.status_code}` : ""}
                              {failed ? " · error" : ""}
                            </p>
                          </div>
                        </div>
                        <div className="relative h-4" aria-hidden>
                          <div
                            className={cn("absolute top-1 h-2 rounded-sm", failed ? "bg-danger" : "bg-muted-foreground/60")}
                            style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
                          />
                        </div>
                        <span className={cn("text-right text-sm tabular-nums", failed ? "text-danger" : "text-foreground")}>
                          {formatMs(span.duration_ms)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </div>
          )}
        </Panel>

        <Panel>
          <PanelHeader title="Logs" description={logs.length ? `${logs.length} correlated log lines` : undefined} />
          {logs.length === 0 ? (
            <EmptyState title="No logs were correlated with this trace" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-32">Time (UTC)</TableHead>
                  <TableHead className="w-24">Level</TableHead>
                  <TableHead>Message</TableHead>
                  <TableHead>Span</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((l, i) => (
                  <TableRow key={`${l.timestamp}-${i}`}>
                    <TableCell mono tone="muted" title={absoluteTime(l.timestamp)}>
                      {clockTime(l.timestamp)}
                    </TableCell>
                    <TableCell>
                      <Badge tone={levelTone(l.level)}>{l.level.toLowerCase()}</Badge>
                    </TableCell>
                    <TableCell className="max-w-xl truncate whitespace-normal" title={l.message}>
                      {l.message}
                    </TableCell>
                    <TableCell mono tone="muted">
                      {l.span_id ? l.span_id.slice(0, 8) : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Panel>

        <p className="text-xs text-subtle-foreground">
          <Link href="/requests" className="focus-ring rounded-sm text-brand-text underline-offset-4 hover:underline">
            Back to requests
          </Link>
        </p>
      </div>
    </>
  );
}
