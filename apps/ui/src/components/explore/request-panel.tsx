"use client";

import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { consumerOf, formatBytes, isSampledOut, latencyTone, logTime, statusClass } from "@/lib/explore";
import { TIMELINE_FIRST, badgeText, errorSummary, leadSection, offsetText, queryPairs, sameWindow, timelineSteps } from "@/lib/explore-detail";
import { shownPath } from "@/lib/first-data";
import { statusText } from "@/lib/http-status";
import type { RequestDetail, RequestDetailRead, RequestRow, TraceLog, TraceSpan } from "@/lib/identity";
import {
  DETAIL_LOAD_FAILED,
  DETAIL_NOT_FOUND,
  DRAWER_TABS,
  type DrawerTab,
  type JsonLine,
  MARKER_TITLE,
  allContainers,
  type StreamEvent,
  contentTypeOf,
  curlCommand,
  defaultExpanded,
  detailRead,
  formatExact,
  jsonLines,
  markerSegments,
  moveTab,
  offsetMs,
  parseBody,
  parseHeaders,
  requestDetailPath,
  sizeLabel,
} from "@/lib/request-detail";
import { EXCEPTION_LOGGER, type ExceptionBlock, type StackFrame, exceptionLog, frameLocation, parseException } from "@/lib/stack-trace";
import { useTimeZone } from "@/lib/time-zone-context";
import { endpointHref, formatLatency } from "@/lib/traffic";
import { projectHref } from "@/lib/routes";
import { ObIcon } from "../onboarding/ob";
import { useAppName } from "./app-names";
import { type FilterApi, filterActions } from "./field-actions";
import { type FieldAction, FieldMenu } from "./field-menu";
import { isOpenMap, useStored } from "./use-stored";

/** Height of one JSON line in px; the viewer's virtual window depends on it, so the CSS uses the same number. */
const LINE_HEIGHT = 20;
/** JSON lines rendered above and below the visible ones. */
const LINE_OVERSCAN = 20;

type Load = { kind: "loading" } | { kind: "detail"; data: RequestDetailRead } | { kind: "not_found" } | { kind: "error" };

/**
 * The drawer the request panel sits in (#1061): Supabase's Sheet from the right
 * (packages/ui shadcn/ui/sheet.tsx: `fixed inset-y-0 right-0 h-full border-l bg-popover shadow-lg`,
 * slide in 300ms, sheet.tsx:200-214) without its overlay (`hasOverlay={false}`, sheet.tsx:164), so
 * the table behind it stays readable and never reflows. Its width is the sheet's default
 * `lg:w-1/3` with the 400px floor of Supabase's log panel (ServiceFlowPanel.tsx `minSize={400}`);
 * the whole screen on phones. A click outside it closes it, except on a row of the table, which
 * opens that row instead; Esc closes it from the page.
 */
export function RequestDrawer({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t || ref.current?.contains(t)) return;
      // Rows switch the request; popovers and menus (portalled) keep it open.
      if (t.closest?.(".exl-body .exl-row, .org-pop, .exc-menu, .ah-dialog, [role='dialog']")) return;
      close.current();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, []);
  return (
    <div ref={ref} className="exd-sheet" role="dialog" aria-modal="false" aria-label={label}>
      {children}
    </div>
  );
}

/**
 * The request panel (#1053, in a drawer since #1061, after Supabase's ServiceFlowPanel): one
 * request read from `GET /requests/{id}`. A 36px header (ServiceFlowPanel.tsx:91: `h-9 px-4
 * gap-3`, title `text-sm font-medium leading-6`) names the status, method and path, with Copy
 * link, Copy as cURL, Copy JSON and Close (Esc). Tabs as Supabase's `ui` Tabs
 * (ServiceFlowPanel.tsx:120 `gap-x-5 px-4`, triggers `py-2.5`, tabs.tsx:69 `text-sm`, a 2px
 * underline on the active one): Request (summary, client, query, headers, body), Response (the
 * failure first, then status, headers and body), Timeline, Consumer and Raw. It opens on Response
 * when the request failed (#988). The footer (`border-t py-1.5 pl-4 pr-3 text-xs`) holds the keys
 * and previous / next. `row` is the loaded row when the request is in the list; `inList` false
 * says it is outside it, with "Show it in the list".
 */
export function RequestPanel({
  project,
  id,
  row,
  inList,
  link,
  api,
  onClose,
  onMove,
  canPrev,
  canNext,
  onShowInList,
}: {
  project: string;
  id: string;
  row: RequestRow | null;
  inList: boolean;
  /** The page path with this request open, for Copy link. */
  link: string;
  api: FilterApi;
  onClose: () => void;
  onMove: (delta: number) => void;
  canPrev: boolean;
  canNext: boolean;
  onShowInList: (at: string) => void;
}) {
  const tz = useTimeZone();
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [picked, setPicked] = useState<DrawerTab | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const titleId = useId();
  const tabsId = useId();

  useEffect(() => {
    const ctl = new AbortController();
    setLoad({ kind: "loading" });
    setSaid(null);
    (async () => {
      try {
        const res = await fetch(requestDetailPath(project, id), { signal: ctl.signal, cache: "no-store", headers: { accept: "application/json" } });
        const result = detailRead(res.status, await res.json().catch(() => null));
        if (result.kind === "expired") return window.location.assign(result.next);
        setLoad(result.kind === "detail" ? result : result.kind === "not_found" ? result : { kind: "error" });
      } catch (err) {
        if ((err as Error).name !== "AbortError") setLoad({ kind: "error" });
      }
    })();
    return () => ctl.abort();
  }, [project, id, attempt]);

  const detail = load.kind === "detail" ? load.data : null;
  const r: RequestRow | null = detail?.request ?? row;
  const cls = r ? statusClass(r.status_code) : "other";
  // Until the reader picks a tab: Response when the request failed, else Request (#988).
  const failed = detail ? leadSection(detail.request, Boolean(exceptionLog(detail.logs ?? []))) !== "summary" || detail.request.status_code >= 400 : (row?.status_code ?? 0) >= 400;
  const tab: DrawerTab = picked ?? (failed ? "response" : "request");

  const copy = async (text: string, ok: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setSaid(ok);
    } catch {
      setSaid("Couldn’t copy. Your browser blocked the clipboard.");
    }
  };

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = moveTab(e.key, tab);
    if (next === null) return;
    e.preventDefault();
    setPicked(next);
    document.getElementById(`${tabsId}-${next}-tab`)?.focus();
  };

  const path = r ? shownPath(r) : "";

  return (
    <section className="exd" aria-labelledby={titleId}>
      <header className="exd-head">
        <h2 id={titleId} className="exd-title">
          {r ? (
            <>
              <span className={`exd-badge exd-badge--${cls}`} title={statusText(r.status_code)}>
                {badgeText(r.status_code)}
              </span>
              <span className="exd-method">{r.method.toUpperCase()}</span>
              <span className="exl-clip exd-path" title={path}>
                <bdi>{path}</bdi>
              </span>
            </>
          ) : (
            <span className="exd-method">Request</span>
          )}
        </h2>
        <div className="exd-actions">
          <button type="button" className="exd-act" aria-label="Copy link" title="Copy link" onClick={() => copy(`${window.location.origin}${link}`, "Copied the link to this request.")}>
            Link
          </button>
          <button
            type="button"
            className="exd-act"
            aria-label="Copy as cURL"
            title="Copy as cURL"
            disabled={!detail}
            onClick={() => detail && copy(curlCommand(detail.request), "Copied the cURL command. Redacted values stay as [redacted].")}
          >
            cURL
          </button>
          <button
            type="button"
            className="exd-act"
            aria-label="Copy JSON"
            title="Copy JSON"
            disabled={!detail}
            onClick={() => detail && copy(JSON.stringify(detail.request, null, 2), "Copied the request as JSON.")}
          >
            JSON
          </button>
          <button type="button" className="exd-close" aria-label="Close request details (Esc)" title="Close (Esc)" onClick={onClose}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
      </header>
      {r ? (
        <p className="exd-sub">
          <span className={`exl-lat--${latencyTone(r.response_time_ms)}`}>{formatLatency(r.response_time_ms)}</span>
          <time dateTime={r.timestamp} title={formatExact(r.timestamp, tz)}>
            {formatExact(r.timestamp, tz)}
          </time>
        </p>
      ) : null}
      <p className="exd-said" role="status">
        {said}
      </p>
      {!inList && r ? (
        <div className="exd-outside" role="status">
          This request is outside the current list.{" "}
          <button type="button" className="exf-link" onClick={() => onShowInList(r.timestamp)}>
            Show it in the list
          </button>
        </div>
      ) : null}

      <div className="exd-tabs" role="tablist" aria-label="Request details" onKeyDown={onTabKey}>
        {DRAWER_TABS.map((x) => (
          <button
            key={x.slug}
            type="button"
            role="tab"
            id={`${tabsId}-${x.slug}-tab`}
            aria-controls={`${tabsId}-panel`}
            aria-selected={tab === x.slug}
            tabIndex={tab === x.slug ? 0 : -1}
            onClick={() => setPicked(x.slug)}
          >
            {x.label}
            {x.slug === "timeline" && detail ? <span className="rd-count">{(detail.spans?.length ?? 0) + (detail.logs?.length ?? 0) || null}</span> : null}
          </button>
        ))}
      </div>

      <div className="exd-body" role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-${tab}-tab`} tabIndex={0}>
        {load.kind === "loading" ? (
          <div className="rd-loading" aria-busy="true" aria-label="Loading the request">
            {[0, 1, 2, 3, 4].map((i) => (
              <span key={i} className="exl-bone" aria-hidden="true" />
            ))}
          </div>
        ) : load.kind === "not_found" ? (
          <Notice>{DETAIL_NOT_FOUND}</Notice>
        ) : load.kind === "error" ? (
          <Notice error>
            {DETAIL_LOAD_FAILED}{" "}
            <button type="button" className="rd-linkbtn" onClick={() => setAttempt((a) => a + 1)}>
              Try again
            </button>
          </Notice>
        ) : tab === "request" ? (
          <RequestTab key={id} data={load.data} project={project} api={api} />
        ) : tab === "response" ? (
          <ResponseTab key={id} data={load.data} api={api} />
        ) : tab === "timeline" ? (
          <Timeline spans={load.data.spans ?? []} logs={load.data.logs ?? []} at={load.data.request.timestamp} traced={Boolean(load.data.request.trace_id)} />
        ) : tab === "consumer" ? (
          <ConsumerTab project={project} r={load.data.request} api={api} />
        ) : (
          <RawTab data={load.data} onCopy={(text) => copy(text, "Copied the stored request.")} />
        )}
      </div>

      <footer className="exd-foot">
        <span className="exd-keys">↑ ↓ to move · Shift ↑ ↓ to select · Esc to close</span>
        <button type="button" className="exd-nav" aria-label="Previous request" disabled={!canPrev} onClick={() => onMove(-1)}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 10l4-4 4 4" />
          </svg>
        </button>
        <button type="button" className="exd-nav" aria-label="Next request" disabled={!canNext} onClick={() => onMove(1)}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 6l4 4 4-4" />
          </svg>
        </button>
      </footer>
    </section>
  );
}

function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return (
    <div className={`ex-notice${error ? " ex-notice--error" : ""}`} role={error ? "alert" : "status"}>
      <ObIcon name="info" />
      <p>{children}</p>
    </div>
  );
}

const SAMPLED_OUT = "Sampled out: the SDK kept a base record of this request without headers or bodies.";

/** Text with the SDK's markers styled apart, each saying what it means. */
function Marked({ text }: { text: string }) {
  return (
    <>
      {markerSegments(text).map((s, i) =>
        s.marker ? (
          <mark key={i} className={`rd-marker rd-marker--${s.marker}`} title={MARKER_TITLE[s.marker]}>
            {s.text}
          </mark>
        ) : (
          s.text
        ),
      )}
    </>
  );
}

// ---------------------------------------------------------------- overview

type SectionId = "error" | "summary" | "request" | "response" | "client" | "consumer" | "validation" | "exception";

const SECTION_ICON: Record<SectionId, ReactNode> = {
  error: <path d="M8 2.5l6 10.5H2zM8 6.5v3M8 11.3v.2" />,
  summary: <path d="M3 4h10M3 8h10M3 12h6" />,
  request: <path d="M3 8h9M9 5l3 3-3 3" />,
  response: <path d="M13 8H4M7 5L4 8l3 3" />,
  client: <path d="M2.5 3.5h11v7h-11zM6 13h4" />,
  consumer: <path d="M8 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM3 13.5c.8-2.2 2.7-3.3 5-3.3s4.2 1.1 5 3.3" />,
  validation: <path d="M3 8.5l3 3 7-7" />,
  exception: <path d="M8 2.5l6 10.5H2zM8 6.5v3M8 11.3v.2" />,
};

const SECTION_LABEL: Record<SectionId, string> = {
  error: "Error",
  summary: "Summary",
  request: "Request",
  response: "Response",
  client: "Client",
  consumer: "Consumer",
  validation: "Validation",
  exception: "Exception",
};

/** A collapsible Overview section with its icon; open or closed is remembered per section. */
function Section({ id, open, onToggle, count, children }: { id: SectionId; open: boolean; onToggle: () => void; count?: number; children: ReactNode }) {
  const bodyId = useId();
  return (
    <section className={`exd-sec exd-sec--${id}${open ? " is-open" : ""}`} aria-label={SECTION_LABEL[id]} data-section={id}>
      <h3 className="exd-sec__h">
        <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
          <svg className="exd-sec__icon" viewBox="0 0 16 16" aria-hidden="true">
            {SECTION_ICON[id]}
          </svg>
          {SECTION_LABEL[id]}
          {count ? <span className="rd-count">{count}</span> : null}
          <svg className="exd-sec__chev" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 6l4 4 4-4" />
          </svg>
        </button>
      </h3>
      {open ? (
        <div className="exd-sec__body" id={bodyId}>
          {children}
        </div>
      ) : null}
    </section>
  );
}

/** One field row: its label, its value, and the ⋯ menu to filter by it or copy it. */
function Field({ label, children, copy, actions = [] }: { label: string; children: ReactNode; copy?: string; actions?: FieldAction[] }) {
  if (children === null || children === undefined || children === "") return null;
  return (
    <div className="exd-field">
      <dt>{label}</dt>
      <dd>
        <span className="exd-field__v">{children}</span>
        {copy !== undefined || actions.length ? <FieldMenu label={label} copy={copy} actions={actions} /> : null}
      </dd>
    </div>
  );
}

const DEFAULT_OPEN: Record<string, boolean> = { error: true, summary: true, request: true, response: true, client: false, consumer: true, validation: true, exception: true };

/** Which sections are open: remembered per section, the failure's always open (#988). */
function useSections(forced: SectionId | null) {
  const [stored, setStored] = useStored<Record<string, boolean>>("apilens.explore.panel.sections", DEFAULT_OPEN, isOpenMap);
  const isOpen = (s: SectionId) => s === forced || (stored[s] ?? DEFAULT_OPEN[s]);
  const toggle = (s: SectionId) => setStored((m) => ({ ...m, [s]: !isOpen(s) }));
  return { isOpen, toggle };
}

/** The Request tab (#1061): the summary, the client, then query parameters, headers and body. */
function RequestTab({ data, project, api }: { data: RequestDetailRead; project: string; api: FilterApi }) {
  const tz = useTimeZone();
  const r = data.request;
  const { isOpen, toggle } = useSections(null);
  const app = useAppName(r.app_id);
  const fa = (field: Parameters<typeof filterActions>[1], value: string) => (value ? filterActions(api, field, value) : []);
  const minute = sameWindow(r.timestamp, "minute");
  const hour = sameWindow(r.timestamp, "hour");
  const timeActions: FieldAction[] = [
    ...(minute ? [{ label: "Same minute", run: () => api.setWindow(minute.from, minute.to) }] : []),
    ...(hour ? [{ label: "Same hour", run: () => api.setWindow(hour.from, hour.to) }] : []),
  ];
  const query = queryPairs(r.raw_path);
  const url = r.base_url ? `${r.base_url.replace(/\/+$/, "")}${r.raw_path}` : r.raw_path;
  const attrs = Object.entries(r.attributes ?? {});

  return (
    <div className="exd-overview">
      <Section id="summary" open={isOpen("summary")} onToggle={() => toggle("summary")}>
        <dl className="exd-dl">
          <Field label="Method" copy={r.method} actions={fa("method", r.method)}>
            {r.method.toUpperCase()}
          </Field>
          <Field
            label="Route"
            copy={r.path}
            actions={[...fa("path", r.path), { label: "Open endpoint", href: endpointHref(project, { method: r.method, path: r.path }, { range: "24h" }) }]}
          >
            <code>{r.path}</code>
          </Field>
          <Field label="URL" copy={url} actions={fa("url", r.raw_path)}>
            <code>{url}</code>
          </Field>
          <Field label="Request size" copy={String(r.request_size ?? "")}>
            {formatBytes(r.request_size)}
          </Field>
          <Field label="Time" copy={r.timestamp} actions={timeActions}>
            {formatExact(r.timestamp, tz)}
          </Field>
          <Field label="App" copy={app ?? r.app_id} actions={fa("app", r.app_id ?? "")}>
            {app ?? r.app_id}
          </Field>
          <Field label="Environment" copy={r.environment} actions={fa("env", r.environment)}>
            {r.environment}
          </Field>
          <Field
            label="Trace ID"
            copy={r.trace_id}
            actions={r.trace_id ? [{ label: "Show this trace’s requests", run: () => api.setConds([...api.conds.filter((c) => c.field !== "trace_id"), { field: "trace_id", op: "eq", value: r.trace_id }]) }, ...fa("trace_id", r.trace_id).slice(1)] : []}
          >
            {r.trace_id ? <code>{r.trace_id}</code> : null}
          </Field>
          <Field label="Release" copy={r.release}>
            {r.release}
          </Field>
          <Field label="Commit" copy={r.commit}>
            {r.commit ? <code>{r.commit}</code> : null}
          </Field>
        </dl>
      </Section>
      <Section id="client" open={isOpen("client")} onToggle={() => toggle("client")}>
        <dl className="exd-dl">
          <Field label="Client IP" copy={r.ip_address} actions={fa("ip", r.ip_address ?? "")}>
            {r.ip_address ? <code>{r.ip_address}</code> : null}
          </Field>
          <Field label="User agent" copy={r.user_agent} actions={fa("user_agent", r.user_agent)}>
            {r.user_agent}
          </Field>
          <Field label="Consumer" copy={r.consumer_id || consumerOf(r) || undefined} actions={fa("consumer", r.consumer_id || consumerOf(r) || "")}>
            {consumerOf(r)}
          </Field>
        </dl>
      </Section>
      <Section id="request" open={isOpen("request")} onToggle={() => toggle("request")}>
        {isSampledOut(r) ? (
          <Notice>{SAMPLED_OUT}</Notice>
        ) : (
          <>
            {query.length ? (
              <table className="rd-table rd-table--kv" aria-label="Query parameters">
                <caption className="rd-cap">Query parameters</caption>
                <tbody>
                  {query.map(([k, v], i) => (
                    <tr key={`${k}#${i}`}>
                      <th scope="row">{k}</th>
                      <td>
                        <Marked text={v} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            <HeaderTable title="Request headers" text={r.request_headers} />
            <BodyView text={r.request_body} size={r.request_size} headers={r.request_headers} what="request" />
          </>
        )}
      </Section>
      {attrs.length ? (
        <section className="rd-section" aria-label="Attributes">
          <h3 className="rd-h">Attributes</h3>
          <AttrTable attrs={attrs} label="Request attributes" />
        </section>
      ) : null}
    </div>
  );
}

/**
 * The Response tab (#1061): for a failure the Error block, the validation errors and the
 * exception first (#988), then the status, latency and size, the headers and the body.
 */
function ResponseTab({ data, api }: { data: RequestDetailRead; api: FilterApi }) {
  const r = data.request;
  const exc = useMemo(() => exceptionLog(data.logs ?? []), [data.logs]);
  const excInfo = exc ? { type: exc.attributes?.["exception.type"], message: exc.attributes?.["exception.message"] } : null;
  const lead = leadSection(r, Boolean(exc));
  const summary = errorSummary(r, excInfo);
  const [forced] = useState<SectionId | null>(lead === "summary" ? null : lead === "response" ? "response" : lead);
  const { isOpen, toggle } = useSections(forced);
  const validation = r.validation_errors ?? [];
  const fa = (field: Parameters<typeof filterActions>[1], value: string) => (value ? filterActions(api, field, value) : []);

  return (
    <div className="exd-overview">
      {summary ? (
        <Section id="error" open={isOpen("error")} onToggle={() => toggle("error")}>
          <div className="exd-error">
            <p className="exd-error__title">{summary.title}</p>
            {summary.detail ? <p className="exd-error__detail">{summary.detail}</p> : null}
            {summary.body ? <ErrorBody text={r.response_body} start={summary.body} more={summary.more} /> : null}
          </div>
        </Section>
      ) : null}
      {validation.length ? (
        <Section id="validation" open={isOpen("validation")} onToggle={() => toggle("validation")} count={validation.length}>
          <ValidationTable errors={validation} />
        </Section>
      ) : null}
      {exc ? (
        <Section id="exception" open={isOpen("exception")} onToggle={() => toggle("exception")}>
          <ExceptionView label="Exception" payload={exc.payload || exc.message} type={excInfo?.type} message={excInfo?.message} />
        </Section>
      ) : null}
      <Section id="response" open={isOpen("response")} onToggle={() => toggle("response")}>
        <dl className="exd-dl exd-dl--top">
          <Field label="Status" copy={String(r.status_code)} actions={fa("status", String(r.status_code))}>
            <span className={`exl-status exl-status--${statusClass(r.status_code)}`}>{statusText(r.status_code)}</span>
          </Field>
          <Field label="Latency" copy={String(r.response_time_ms)}>
            {formatLatency(r.response_time_ms)}
          </Field>
          <Field label="Response size" copy={String(r.response_size ?? "")}>
            {formatBytes(r.response_size)}
          </Field>
        </dl>
        {isSampledOut(r) ? (
          <Notice>{SAMPLED_OUT}</Notice>
        ) : (
          <>
            <HeaderTable title="Response headers" text={r.response_headers} />
            <BodyView text={r.response_body} size={r.response_size} headers={r.response_headers} what="response" />
          </>
        )}
      </Section>
    </div>
  );
}

/** The start of the response body in the Error block, with Show more. */
function ErrorBody({ text, start, more }: { text: string; start: string; more: boolean }) {
  const [all, setAll] = useState(false);
  return (
    <>
      <pre className="rd-pre exd-error__body">
        <Marked text={all ? text : `${start}${more ? "…" : ""}`} />
      </pre>
      {more ? (
        <button type="button" className="exf-link" onClick={() => setAll((a) => !a)}>
          {all ? "Show less" : "Show more"}
        </button>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- timeline

/**
 * The Timeline tab: the trace's spans and logs on one rail, oldest first, each with a level dot,
 * its name, its duration and its offset from the request ("+12.4 ms"). The first three show, then
 * "+N more". A span or log opens its attributes, events and payload inline.
 */
function Timeline({ spans, logs, at, traced }: { spans: TraceSpan[]; logs: TraceLog[]; at: string; traced: boolean }) {
  const steps = useMemo(() => timelineSteps(spans, logs, at), [spans, logs, at]);
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  const id = useId();
  if (!steps.length) {
    return <p className="rd-empty">{traced ? "No spans or logs were reported for this request’s trace." : "This request has no trace id, so there are no spans or logs to show."}</p>;
  }
  const shown = all ? steps : steps.slice(0, TIMELINE_FIRST);
  const toggle = (i: number) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  return (
    <section className="rd-section" aria-label="Timeline">
      <ol className="exd-rail">
        {shown.map((s, i) => {
          const tone = s.kind === "span" ? (s.failed ? "error" : "plain") : s.level;
          const isOpen = open.has(i);
          return (
            <li key={`${s.kind}${s.at}#${i}`} className={`exd-step exd-step--${tone}${isOpen ? " is-open" : ""}`}>
              <button type="button" className="exd-step__row" aria-expanded={isOpen} aria-controls={`${id}-${i}`} onClick={() => toggle(i)}>
                <span className="exd-step__dot" aria-hidden="true" />
                <span className="exd-step__kind">{s.kind === "span" ? "Span" : s.log.level || "Log"}</span>
                <span className="exd-step__name">{s.kind === "span" ? s.span.name || s.span.span_id : <Marked text={s.log.message} />}</span>
                {s.kind === "span" ? <span className="exd-step__dur">{formatLatency(s.span.duration_ms)}</span> : null}
                <span className="exd-step__off">{offsetText(s.offset)}</span>
              </button>
              {isOpen ? (
                <div className="exd-step__detail" id={`${id}-${i}`}>
                  {s.kind === "span" ? <SpanDetail span={s.span} at={at} /> : <LogDetail log={s.log} />}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      {!all && steps.length > TIMELINE_FIRST ? (
        <button type="button" className="exf-link exd-more" onClick={() => setAll(true)}>
          +{steps.length - TIMELINE_FIRST} more
        </button>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------- consumer

type ConsumerRead =
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "error" }
  | { kind: "ok"; c: { consumer_id: string; consumer_name: string; consumer_group: string; first_seen: string; last_seen: string; requests: number; recent: RequestRow[] } };

/** The Consumer tab: who made the request, "Filter by this consumer" and their last 24 hours. */
function ConsumerTab({ project, r, api }: { project: string; r: RequestDetail; api: FilterApi }) {
  const tz = useTimeZone();
  const [read, setRead] = useState<ConsumerRead>({ kind: "loading" });
  const cid = r.consumer_id;
  useEffect(() => {
    if (!cid) return setRead({ kind: "none" });
    const ctl = new AbortController();
    setRead({ kind: "loading" });
    fetch(`/api/projects/${encodeURIComponent(project)}/consumers/${encodeURIComponent(cid)}`, { signal: ctl.signal, cache: "no-store", headers: { accept: "application/json" } })
      .then(async (res) => {
        const b = (await res.json().catch(() => null)) as { ok?: boolean; consumer?: Extract<ConsumerRead, { kind: "ok" }>["c"]; code?: string; next?: string } | null;
        if (res.status === 401 && b?.code === "session_expired") return window.location.assign(b.next ?? "/sign-in");
        setRead(b?.ok && b.consumer ? { kind: "ok", c: b.consumer } : b?.code === "not_found" ? { kind: "none" } : { kind: "error" });
      })
      .catch((err: Error) => {
        if (err.name !== "AbortError") setRead({ kind: "error" });
      });
    return () => ctl.abort();
  }, [project, cid]);

  if (!cid) return <p className="rd-empty">No consumer: the app did not identify who made this request.</p>;
  if (read.kind === "loading") return <div className="rd-loading" aria-busy="true" aria-label="Loading the consumer" />;
  if (read.kind === "error") return <Notice error>We couldn’t load this consumer just now.</Notice>;
  const c = read.kind === "ok" ? read.c : null;
  const all = `/project/${encodeURIComponent(project)}/explore?range=24h&filter=${encodeURIComponent(`consumer:eq:${cid}`)}`;
  return (
    <div className="exd-consumer">
      <div className="exd-card">
        <p className="exd-card__name">{c?.consumer_name || r.consumer_name || cid}</p>
        <dl className="exd-dl">
          <Field label="ID">
            <code>{cid}</code>
          </Field>
          <Field label="Group">{c?.consumer_group || r.consumer_group}</Field>
          <Field label="First seen">{c?.first_seen ? formatExact(c.first_seen, tz) : null}</Field>
          <Field label="Last seen">{c?.last_seen ? formatExact(c.last_seen, tz) : null}</Field>
        </dl>
        <div className="exd-card__actions">
          <button
            type="button"
            className="ah-btn ah-btn--secondary ah-btn--sm"
            onClick={() => api.setConds([...api.conds.filter((x) => x.field !== "consumer"), { field: "consumer", op: "eq", value: cid }])}
          >
            Filter by this consumer
          </button>
          <a className="ah-btn ah-btn--ghost ah-btn--sm" href={`${projectHref(project, "consumers")}?consumer=${encodeURIComponent(cid)}`}>
            Open consumer
          </a>
        </div>
      </div>
      <h3 className="rd-h">Last 24 hours</h3>
      {c && c.recent.length ? (
        <table className="rd-table exd-mini" aria-label="The consumer’s latest requests">
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Status</th>
              <th scope="col">Request</th>
            </tr>
          </thead>
          <tbody>
            {c.recent.slice(0, 10).map((x, i) => {
              const t = logTime(x.timestamp, Date.now(), tz);
              return (
                <tr key={x.id ?? `${x.timestamp}#${i}`}>
                  <td className="rd-num">
                    {t.day ? `${t.day} ` : ""}
                    {t.clock}
                  </td>
                  <td>
                    <span className={`exl-status exl-status--${statusClass(x.status_code)}`}>{x.status_code}</span>
                  </td>
                  <td>
                    <code>
                      {x.method.toUpperCase()} {shownPath(x)}
                    </code>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="rd-empty">No requests from this consumer in the last 24 hours.</p>
      )}
      <a className="exf-link" href={all}>
        View all in Explore
      </a>
    </div>
  );
}

// ---------------------------------------------------------------- raw

function RawTab({ data, onCopy }: { data: RequestDetailRead; onCopy: (text: string) => void }) {
  const text = useMemo(() => JSON.stringify(data.request, null, 2), [data.request]);
  return (
    <section className="rd-section" aria-label="Raw request">
      <div className="rd-exc__bar">
        <h3 className="rd-h">The stored request</h3>
        <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={() => onCopy(text)}>
          Copy
        </button>
      </div>
      <JsonView value={data.request} />
    </section>
  );
}

// ---------------------------------------------------------------- headers

function HeaderTable({ title, text }: { title: string; text: string }) {
  const pairs = parseHeaders(text);
  return (
    <section className="rd-section" aria-label={title}>
      <h3 className="rd-h">{title}</h3>
      {pairs === null ? (
        <p className="rd-empty">Not captured.</p>
      ) : (
        <table className="rd-table rd-table--kv">
          <tbody>
            {pairs.map(([k, v], i) => (
              <tr key={`${k}#${i}`}>
                <th scope="row">{k}</th>
                <td>
                  <Marked text={v} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- bodies

function BodyView({ text, size, headers, what }: { text: string; size: number | undefined; headers: string; what: "request" | "response" }) {
  const body = useMemo(() => parseBody(text, contentTypeOf(headers)), [text, headers]);
  if (body.kind === "empty") {
    return <p className="rd-empty">{size ? `The ${what} body (${formatBytes(size)}) was not captured.` : `No ${what} body.`}</p>;
  }
  const stored = new Blob([text]).size;
  return (
    <section className="rd-section" aria-label={what === "request" ? "Request body" : "Response body"}>
      <p className="rd-meta">
        {formatBytes(size)} sent{size !== undefined && stored < size ? `, ${formatBytes(stored)} stored` : ""}
      </p>
      {body.kind === "json" ? (
        <JsonView value={body.value} />
      ) : body.kind === "form" ? (
        <table className="rd-table rd-table--kv" aria-label="Form fields">
          <tbody>
            {body.fields.map(([k, v], i) => (
              <tr key={`${k}#${i}`}>
                <th scope="row">{k}</th>
                <td>
                  <Marked text={v} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : body.kind === "events" ? (
        <EventStream events={body.events} />
      ) : (
        <pre className="rd-pre">
          <Marked text={body.text} />
        </pre>
      )}
    </section>
  );
}

/** The text a stream event's row previews: its `content` when it has one. */
function eventPreview(e: StreamEvent): string {
  const content = e.data !== null && typeof e.data === "object" ? (e.data as Record<string, unknown>).content : undefined;
  if (typeof content === "string") return content;
  return typeof e.data === "string" ? e.data : "";
}

/** The disclosure arrow of an expandable row; CSS turns it down while the row is open. */
function Chevron() {
  return (
    <svg className="rd-chev" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  );
}

/** Which rows of a list are open, with Expand all / Collapse all. */
function useOpenRows(count: number) {
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  const toggle = useCallback(
    (i: number) =>
      setOpen((cur) => {
        const next = new Set(cur);
        if (next.has(i)) next.delete(i);
        else next.add(i);
        return next;
      }),
    [],
  );
  const all = useCallback(() => setOpen(new Set(Array.from({ length: count }, (_, i) => i))), [count]);
  const none = useCallback(() => setOpen(new Set()), []);
  return { open, toggle, all, none };
}

/** The bar over an expandable list: what clicking a row does, and Expand all / Collapse all. */
function ListBar({ hint, anyOpen, onAll, onNone }: { hint: string; anyOpen: boolean; onAll: () => void; onNone: () => void }) {
  return (
    <div className="rd-listbar">
      <span className="rd-listbar__hint">{hint}</span>
      <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={onAll}>
        Expand all
      </button>
      <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={onNone} disabled={!anyOpen}>
        Collapse all
      </button>
    </div>
  );
}

/** A server-sent event stream: one row per event; clicking a row opens its data as a JSON tree. */
function EventStream({ events }: { events: StreamEvent[] }) {
  const { open, toggle, all, none } = useOpenRows(events.length);
  const id = useId();
  return (
    <>
      <p className="rd-meta">
        {events.length} {events.length === 1 ? "event" : "events"} in the stream, in the order they were sent
      </p>
      <div className="rd-list">
        <ListBar hint="Click an event to see its data; click again to close it." anyOpen={open.size > 0} onAll={all} onNone={none} />
        <ol className="rd-events">
          {events.map((e, i) => {
            const preview = eventPreview(e);
            const isOpen = open.has(i);
            return (
              <li key={i} className={isOpen ? "is-open" : undefined}>
                <button type="button" className="rd-events__row" aria-expanded={isOpen} aria-controls={`${id}-${i}`} onClick={() => toggle(i)}>
                  <Chevron />
                  <span className="rd-events__n">{i + 1}</span>
                  <code className="rd-events__name">{e.event}</code>
                  {preview ? <span className="rd-events__preview">{preview}</span> : null}
                  {e.partial ? <span className="rd-events__cut">cut at the capture limit</span> : null}
                </button>
                {isOpen ? (
                  <div className="rd-events__data" id={`${id}-${i}`}>
                    {e.data !== null && typeof e.data === "object" ? (
                      <JsonView value={e.data} />
                    ) : (
                      <pre className="rd-pre">
                        <Marked text={e.text} />
                      </pre>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      </div>
    </>
  );
}

/**
 * A JSON tree: containers open and close, and only the lines in view are in the DOM, so a large
 * body scrolls and toggles without jank.
 */
function JsonView({ value }: { value: unknown }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => defaultExpanded(value));
  const lines = useMemo(() => jsonLines(value, expanded), [value, expanded]);
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  const frame = useRef(0);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setViewport(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame.current);
    };
  }, []);

  const onScroll = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => setScrollTop(scroller.current?.scrollTop ?? 0));
  }, []);

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const height = viewport > 0 ? viewport : 30 * LINE_HEIGHT;
  const start = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - LINE_OVERSCAN);
  const end = Math.min(lines.length, Math.ceil((scrollTop + height) / LINE_HEIGHT) + LINE_OVERSCAN);
  const shown = [];
  for (let i = start; i < end; i++) shown.push(<Line key={lines[i].path} line={lines[i]} index={i} onToggle={toggle} />);

  return (
    <div className="rd-json">
      <div className="rd-json__bar">
        <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={() => setExpanded(allContainers(value))}>
          Expand all
        </button>
        <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={() => setExpanded(new Set([""]))}>
          Collapse all
        </button>
      </div>
      <div className="rd-json__scroll" ref={scroller} onScroll={onScroll}>
        <div className="rd-json__spacer" style={{ height: lines.length * LINE_HEIGHT }}>
          {shown}
        </div>
      </div>
    </div>
  );
}

function Line({ line: l, index, onToggle }: { line: JsonLine; index: number; onToggle: (path: string) => void }) {
  const toggles = l.kind === "open" || (l.kind === "collapsed" && (l.size ?? 0) > 0);
  const key = l.key === undefined ? null : typeof l.key === "number" ? <span className="rd-j-idx">{l.key}: </span> : <span className="rd-j-key">{JSON.stringify(l.key)}: </span>;
  return (
    <div
      className="rd-j-line"
      style={{ transform: `translateY(${index * LINE_HEIGHT}px)`, paddingLeft: 8 + l.depth * 16 }}
    >
      {toggles ? (
        <button type="button" className="rd-j-tog" aria-expanded={l.kind === "open"} aria-label={`${l.kind === "open" ? "Collapse" : "Expand"} ${l.key === undefined ? "body" : String(l.key)}`} onClick={() => onToggle(l.path)}>
          {l.kind === "open" ? "▾" : "▸"}
        </button>
      ) : (
        <span className="rd-j-tog" aria-hidden="true" />
      )}
      {key}
      {l.kind === "string" ? (
        <span className="rd-j-str">
          <Marked text={l.text} />
        </span>
      ) : l.kind === "collapsed" ? (
        <>
          <span className="rd-j-punc">{l.text}</span>
          {l.size ? <span className="rd-j-size"> {sizeLabel(l)}</span> : null}
        </>
      ) : (
        <span className={`rd-j-${l.kind === "open" || l.kind === "close" ? "punc" : l.kind}`}>{l.text}</span>
      )}
      {l.comma ? <span className="rd-j-punc">,</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------- validation

function ValidationTable({ errors }: { errors: { loc: string; msg: string; type: string }[] }) {
  if (!errors.length) return <p className="rd-empty">The app reported no validation errors for this request.</p>;
  return (
    <table className="rd-table">
      <caption className="rd-cap">
        {errors.length === 1 ? "1 field" : `${errors.length} fields`} failed validation.
      </caption>
      <thead>
        <tr>
          <th scope="col">Field</th>
          <th scope="col">Message</th>
          <th scope="col">Type</th>
        </tr>
      </thead>
      <tbody>
        {errors.map((e, i) => (
          <tr key={`${e.loc}#${i}`}>
            <td>
              <code>{e.loc}</code>
            </td>
            <td>
              <Marked text={e.msg} />
            </td>
            <td>
              <code className="ex-muted">{e.type}</code>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * One exception: type and message, then each exception of the chain as a collapsible block of
 * frames (the raised one open), the app's own frames emphasised. A payload that parses as no
 * known stack shows as raw text. Copy copies the payload exactly as stored.
 */
function ExceptionView({
  label,
  payload,
  type,
  message,
  autoFocus = false,
}: {
  label: string;
  payload: string;
  type?: string;
  message?: string;
  /** Focus the section when it mounts: a log's "View the exception" link opened it. */
  autoFocus?: boolean;
}) {
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!autoFocus) return;
    const el = sectionRef.current;
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: "start" });
  }, [autoFocus]);
  const parsed = useMemo(() => parseException(payload), [payload]);
  const [copied, setCopied] = useState<string | null>(null);
  const head = parsed.blocks[0];
  const shownType = type || head?.type || "";
  const shownMessage = message ?? head?.message ?? "";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(payload);
      setCopied("Copied the full exception.");
    } catch {
      setCopied("Couldn’t copy. Your browser blocked the clipboard.");
    }
  };
  return (
    <section ref={sectionRef} className="rd-section rd-exc" aria-label={label} tabIndex={autoFocus ? -1 : undefined}>
      <div className="rd-exc__bar">
        <h3 className="rd-h">{label}</h3>
        <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={copy} disabled={!payload} aria-disabled={!payload || undefined}>
          Copy exception
        </button>
      </div>
      <p className="rd-copied rd-exc__copied" role="status">
        {copied}
      </p>
      {shownType || shownMessage ? (
        <p className="rd-exc__title">
          {shownType ? <code className="rd-exc__type">{shownType}</code> : null}
          {shownMessage ? <span className="rd-exc__msg">{shownMessage}</span> : null}
        </p>
      ) : null}
      {parsed.truncated !== null ? (
        <Notice>
          {parsed.truncated.toLocaleString("en-US")} chars were cut from the middle of this exception to fit the 64 KiB limit. The start and the root cause are kept.
        </Notice>
      ) : null}
      {parsed.format === "raw" ? (
        payload ? (
          <pre className="rd-pre">{payload}</pre>
        ) : null
      ) : (
        parsed.blocks.map((b, i) => <ExceptionBlockView key={i} block={b} open={i === 0} />)
      )}
    </section>
  );
}

function ExceptionBlockView({ block: b, open }: { block: ExceptionBlock; open: boolean }) {
  return (
    <details className={`rd-exb rd-exb--${b.relation}`} open={open}>
      <summary>
        <span className="rd-exb__label">{b.label}</span>
        <code className="rd-exb__type">{b.type}</code>
        {b.message ? <span className="rd-exb__msg">{b.message}</span> : null}
      </summary>
      {b.frames.length ? (
        <ol className="rd-frames">
          {b.frames.map((f, i) => (
            <FrameLine key={i} frame={f} />
          ))}
        </ol>
      ) : (
        <p className="rd-empty rd-exb__none">No frames were reported for this exception.</p>
      )}
    </details>
  );
}

function FrameLine({ frame: f }: { frame: StackFrame }) {
  if (f.note) return <li className="rd-frame rd-frame--note">{f.note}</li>;
  return (
    <li className={`rd-frame${f.inApp ? " is-app" : ""}`}>
      <span className="rd-frame__loc">{frameLocation(f)}</span>
      {f.inApp ? <span className="rd-frame__tag">app</span> : null}
      {f.code ? <code className="rd-frame__code">{f.code}</code> : null}
    </li>
  );
}

const EXCEPTION_EVENT_KEYS = new Set(["exception.type", "exception.message", "exception.stacktrace"]);

function SpanDetail({ span: s, at }: { span: TraceSpan; at: string }) {
  const tz = useTimeZone();
  const items: [string, ReactNode][] = [
    ["Span ID", <code key="id">{s.span_id}</code>],
    ["Kind", s.kind],
    ["Service", s.service_name],
    ["Started", <time key="start" dateTime={s.start} title={formatExact(s.start, tz)}>{offsetMs(s.start, at)}</time>],
    ["Duration", formatLatency(s.duration_ms)],
    ["Status", `${s.status || "unset"}${s.status_code ? ` (${s.status_code})` : ""}`],
    ["Status message", s.status_message ? <Marked key="msg" text={s.status_message} /> : null],
  ];
  const attrs = Object.entries(s.attributes ?? {});
  const events = s.events ?? [];
  return (
    <section className="rd-section rd-span" aria-label={`Span ${s.name || s.span_id}`}>
      <h3 className="rd-h">Span: {s.name || s.span_id}</h3>
      <dl className="rd-dl">
        {items
          .filter(([, v]) => v !== null && v !== undefined && v !== "")
          .map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
      </dl>
      <h4 className="rd-h rd-h--sub">Attributes</h4>
      {attrs.length ? <AttrTable attrs={attrs} label="Span attributes" /> : <p className="rd-empty">No attributes were reported for this span.</p>}
      <h4 className="rd-h rd-h--sub">Events</h4>
      {events.length ? (
        <ol className="rd-spanevents">
          {events.map((e, i) => {
            const ea = e.attributes ?? {};
            const isExc = e.name === "exception";
            const rest = Object.entries(ea).filter(([k]) => !isExc || !EXCEPTION_EVENT_KEYS.has(k));
            return (
              <li key={`${e.time}#${i}`} className="rd-event">
                <p className="rd-event__head">
                  <code>{e.name}</code>
                  <time className="rd-num" dateTime={e.time} title={formatExact(e.time, tz)}>
                    {offsetMs(e.time, at)}
                  </time>
                </p>
                {isExc ? (
                  <ExceptionView label="Exception event" payload={ea["exception.stacktrace"] ?? ""} type={ea["exception.type"]} message={ea["exception.message"]} />
                ) : null}
                {rest.length ? <AttrTable attrs={rest} label={`${e.name} attributes`} /> : null}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="rd-empty">No events were reported for this span.</p>
      )}
    </section>
  );
}

function AttrTable({ attrs, label }: { attrs: [string, string][]; label: string }) {
  return (
    <table className="rd-table rd-table--kv" aria-label={label}>
      <tbody>
        {attrs.map(([k, v]) => (
          <tr key={k}>
            <th scope="row">{k}</th>
            <td>
              <Marked text={v} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LogDetail({ log: l }: { log: TraceLog }) {
  const [copied, setCopied] = useState<string | null>(null);
  const attrs = Object.entries(l.attributes ?? {});
  const payload = l.payload ?? "";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(payload);
      setCopied("Copied the payload.");
    } catch {
      setCopied("Couldn’t copy. Your browser blocked the clipboard.");
    }
  };
  return (
    <div className="rd-logdetail">
      {l.logger_name === EXCEPTION_LOGGER ? <p className="rd-logdetail__exc">This log is the request’s exception; Overview shows it in full.</p> : null}
      <div className="rd-exc__bar">
        <h3 className="rd-h rd-h--sub">Payload</h3>
        {payload ? (
          <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={copy}>
            Copy payload
          </button>
        ) : null}
      </div>
      <p className="rd-copied rd-logdetail__copied" role="status">
        {copied}
      </p>
      {payload ? (
        <pre className="rd-pre rd-logdetail__payload" tabIndex={0} aria-label="Log payload">
          <Marked text={payload} />
        </pre>
      ) : (
        <p className="rd-empty">No payload was reported for this log.</p>
      )}
      <h3 className="rd-h rd-h--sub">Attributes</h3>
      {attrs.length ? <AttrTable attrs={attrs} label="Log attributes" /> : <p className="rd-empty">No attributes were reported for this log.</p>}
    </div>
  );
}
