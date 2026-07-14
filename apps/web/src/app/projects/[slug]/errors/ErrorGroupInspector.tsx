"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Clock, Copy, Fingerprint } from "lucide-react";
import { Badge } from "@/components/reui/badge";
import { Button } from "@/components/reui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/reui/sheet";
import { fmtNum } from "@/lib/format";
import { formatDateTime, timeAgo } from "../endpoints/detail/sections";
import { type ErrorEvent, type ErrorGroup, type OccurrenceRow, reasonPhrase, splitException } from "./util";

function statusBadgeVariant(status: number) {
  if (status >= 500) return "destructive-light" as const;
  if (status >= 400) return "warning-light" as const;
  if (status >= 300) return "info-light" as const;
  return "success-light" as const;
}

function methodBadgeVariant(method: string) {
  switch (method.toUpperCase()) {
    case "GET": return "info-light" as const;
    case "POST": return "success-light" as const;
    case "PUT":
    case "PATCH": return "warning-light" as const;
    case "DELETE": return "destructive-light" as const;
    default: return "secondary" as const;
  }
}

function SectionHead({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <h3 className="m-0 text-xs font-semibold tracking-wide uppercase text-muted-foreground">{title}</h3>
      {action}
    </div>
  );
}

function MetaItem({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-border bg-muted px-3 py-2.5">
      <span className="text-[11px] tracking-wide uppercase text-muted-foreground">{label}</span>
      <span className="text-[15px] font-semibold tabular-nums text-foreground">{value}</span>
    </div>
  );
}

export default function ErrorGroupInspector({
  projectSlug,
  group,
  since,
  until,
  environment,
  onClose,
}: {
  projectSlug: string;
  group: ErrorGroup;
  since: string;
  until: string;
  environment?: string;
  onClose: () => void;
}) {
  const [occurrences, setOccurrences] = useState<OccurrenceRow[] | null>(null);
  const [stackEvent, setStackEvent] = useState<ErrorEvent | null>(null);
  const [copied, setCopied] = useState(false);
  const reqId = useRef(0);

  const isServer = group.status_code >= 500;

  useEffect(() => {
    const myId = ++reqId.current;
    const base = () => {
      const p = new URLSearchParams();
      p.set("since", since);
      p.set("until", until);
      if (environment) p.set("environment", environment);
      p.set("method", group.method);
      p.set("path", group.path);
      return p;
    };
    // Occurrences from the request log (works for 4xx and 5xx), filtered to this status.
    (async () => {
      const p = base();
      p.set("errors_only", "true");
      p.set("limit", "80");
      try {
        const res = await fetch(`/api/projects/${projectSlug}/analytics/endpoint-requests?${p.toString()}`);
        const data = res.ok ? ((await res.json()) as OccurrenceRow[]) : [];
        const rows = (Array.isArray(data) ? data : []).filter((r) => r.status_code === group.status_code);
        if (myId === reqId.current) setOccurrences(rows);
      } catch {
        if (myId === reqId.current) setOccurrences([]);
      }
    })();
    // Stack trace (5xx only) from the exception logs.
    if (isServer) {
      (async () => {
        const p = base();
        p.set("limit", "20");
        try {
          const res = await fetch(`/api/projects/${projectSlug}/analytics/error-events?${p.toString()}`);
          const data = res.ok ? ((await res.json()) as ErrorEvent[]) : [];
          const withTrace = (Array.isArray(data) ? data : []).find(
            (e) => e.status_code === group.status_code && e.payload && e.payload.trim(),
          );
          if (myId === reqId.current) setStackEvent(withTrace || null);
        } catch {
          if (myId === reqId.current) setStackEvent(null);
        }
      })();
    } else {
      setStackEvent(null);
    }
  }, [projectSlug, group.method, group.path, group.status_code, since, until, environment, isServer]);

  const consumers = useMemo(() => {
    const seen = new Set<string>();
    for (const o of occurrences || []) {
      const name = o.consumer || o.consumer_id || "";
      if (name && name !== "unknown") seen.add(name);
    }
    return Array.from(seen);
  }, [occurrences]);

  const stack = stackEvent?.payload || "";
  const { type } = splitException(stackEvent?.message || "");

  const copyStack = async () => {
    try {
      await navigator.clipboard.writeText(stack);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  };

  return (
    <Sheet open onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent
        side="right"
        aria-describedby={undefined}
        className="flex w-full flex-col gap-0 p-0 sm:max-w-[680px]"
      >
        <SheetHeader className="border-b border-border px-5 py-4">
          <SheetTitle className="flex min-w-0 items-center gap-2.5 pr-8 text-[15px] font-semibold">
            <Badge variant={statusBadgeVariant(group.status_code)} className="tabular-nums">
              {group.status_code}
            </Badge>
            <span className="truncate">{reasonPhrase(group.status_code)}</span>
          </SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="mb-4 flex items-center gap-2">
            <Badge variant={methodBadgeVariant(group.method)} className="font-mono">
              {group.method}
            </Badge>
            <span className="truncate font-mono text-[13px] text-muted-foreground">{group.path}</span>
          </div>

          <div className="mb-5 grid grid-cols-2 gap-3">
            <MetaItem label="Occurrences" value={fmtNum(group.occurrences)} />
            <MetaItem label="Consumers" value={fmtNum(group.consumers)} />
            <MetaItem label="Last seen" value={timeAgo(group.last_seen)} />
            <MetaItem label="Status" value={`${group.status_code} · ${reasonPhrase(group.status_code)}`} />
          </div>

          {/* Stack trace — the hero for server errors */}
          <div className="mb-5">
            <SectionHead
              title={type ? `Exception · ${type}` : "Stack trace"}
              action={
                stack ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="gap-1 text-muted-foreground hover:text-foreground"
                    onClick={copyStack}
                  >
                    {copied ? <Check size={12} /> : <Copy size={12} />}
                    {copied ? "Copied" : "Copy"}
                  </Button>
                ) : null
              }
            />
            {stack ? (
              <pre className="request-payload-pre ep-log-trace">{stack}</pre>
            ) : (
              <p className="m-0 text-xs text-muted-foreground">
                {isServer
                  ? "No captured exception traceback for this server error."
                  : "Client error — no exception or stack trace is captured for 4xx responses."}
              </p>
            )}
          </div>

          {/* Affected consumers */}
          {consumers.length > 0 ? (
            <div className="mb-5">
              <SectionHead title="Consumers affected" />
              <div className="flex flex-wrap gap-1.5">
                {consumers.map((c) => (
                  <Badge
                    key={c}
                    variant="outline"
                    radius="full"
                    className="h-auto gap-1.5 px-2.5 py-1 text-[11.5px] font-normal text-muted-foreground"
                  >
                    <Fingerprint size={12} />
                    {c}
                  </Badge>
                ))}
              </div>
            </div>
          ) : null}

          {/* Recent occurrences */}
          <div className="mb-5">
            <SectionHead title="Recent occurrences" />
            {occurrences === null ? (
              <p className="m-0 text-xs text-muted-foreground">Loading…</p>
            ) : occurrences.length === 0 ? (
              <p className="m-0 text-xs text-muted-foreground">No occurrences in this period.</p>
            ) : (
              <ul className="m-0 flex list-none flex-col p-0">
                {occurrences.map((o, i) => (
                  <li
                    key={`${o.trace_id}-${o.timestamp}-${i}`}
                    className="flex items-center gap-3 border-t border-border px-0.5 py-2 text-xs first:border-t-0"
                  >
                    <span className="inline-flex shrink-0 items-center gap-1.5 tabular-nums text-foreground/80">
                      <Clock size={12} />
                      {formatDateTime(o.timestamp)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {o.consumer && o.consumer !== "unknown" ? o.consumer : "—"}
                    </span>
                    {o.trace_id ? (
                      <code
                        className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                        title="Trace ID"
                      >
                        {o.trace_id.slice(0, 12)}
                      </code>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
