"use client";

import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { copyText } from "@/lib/clipboard";
import { consumerOf, formatBytes, isSampledOut, latencyTone, logTime, stampText, statusClass } from "@/lib/explore";
import { TIMELINE_FIRST, badgeText, errorSummary, leadSection, offsetText, queryPairs, sameWindow, timelineSteps } from "@/lib/explore-detail";
import { shownPath } from "@/lib/first-data";
import { reasonPhrase, statusText } from "@/lib/http-status";
import type { RequestDetail, RequestDetailRead, RequestRow, TraceLog, TraceSpan } from "@/lib/identity";
import {
  type Body,
  DETAIL_LOAD_FAILED,
  DETAIL_NOT_FOUND,
  DRAWER_TABS,
  type DrawerTab,
  type JsonLine,
  MARKER_TITLE,
  allContainers,
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
import { isEventStream, parseEventStream } from "@/lib/event-stream";
import { projectHref } from "@/lib/routes";
import { ObIcon } from "../onboarding/ob";
import { useAppName } from "./app-names";
import { CopyAction } from "./copy-action";
import { SseEvents } from "./sse-view";
import { type FilterApi, filterActions } from "./field-actions";
import { type FieldAction, FieldMenu } from "./field-menu";
import { Tip } from "./tip";

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
  const titleId = useId();
  const tabsId = useId();

  useEffect(() => {
    const ctl = new AbortController();
    setLoad({ kind: "loading" });
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

  // The sections are a row of tabs across the top: ←/→ (Home/End) move between them; ↑/↓ keep
  // walking the requests, everywhere in the drawer.
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = moveTab(e.key, tab);
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    setPicked(next);
    document.getElementById(`${tabsId}-${next}-tab`)?.focus();
  };

  const path = r ? shownPath(r) : "";
  const counts: Partial<Record<DrawerTab, number>> = detail ? { timeline: (detail.spans?.length ?? 0) + (detail.logs?.length ?? 0) } : {};

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
          <Tip label="Copy a link to this request, for anyone with access to the project">
            <CopyAction
              className="ah-btn ah-btn--secondary ah-btn--sm ex-tbtn exd-act"
              icon="link"
              label="Copy link"
              ariaLabel="Copy a link to this request"
              text={() => `${window.location.origin}${link}`}
            />
          </Tip>
          <Tip label="Copy as a cURL command; redacted values stay [redacted]">
            <CopyAction
              className="ah-btn ah-btn--secondary ah-btn--sm ex-tbtn exd-act"
              label="cURL"
              ariaLabel="Copy as cURL"
              disabled={!detail}
              text={() => (detail ? curlCommand(detail.request) : "")}
            />
          </Tip>
          <Tip label="Close" keys={["Esc"]}>
            <button type="button" className="exd-close" aria-label="Close request details" aria-keyshortcuts="Escape" onClick={onClose}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </Tip>
        </div>
      </header>
      {!inList && r ? (
        <div className="exd-outside" role="status">
          This request is outside the current list.{" "}
          <button type="button" className="exf-link" onClick={() => onShowInList(r.timestamp)}>
            Show it in the list
          </button>
        </div>
      ) : null}

      <div className="exd-menu" role="tablist" aria-label="Request details" aria-orientation="horizontal" onKeyDown={onTabKey}>
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
            <span>{x.label}</span>
            {counts[x.slug] ? <span className="exd-menu__n">{counts[x.slug]}</span> : null}
          </button>
        ))}
      </div>

      <div className="exd-split">
        {r ? (
          <aside className="exd-side" aria-label="Request facts">
            <Facts r={r} tz={tz} project={project} api={api} />
          </aside>
        ) : null}
        <div className="exd-main" role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-${tab}-tab`} tabIndex={0}>
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
          ) : (
            <RawTab data={load.data} />
          )}
        </div>
      </div>

      <footer className="exd-foot">
        <span className="exd-keys">↑ ↓ to move · Shift ↑ ↓ to select · Esc to close</span>
        <Tip label="Previous request" keys={["↑"]}>
          <button type="button" className="exd-nav" aria-label="Previous request" aria-keyshortcuts="ArrowUp" disabled={!canPrev} onClick={() => onMove(-1)}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 10l4-4 4 4" />
            </svg>
          </button>
        </Tip>
        <Tip label="Next request" keys={["↓"]}>
          <button type="button" className="exd-nav" aria-label="Next request" aria-keyshortcuts="ArrowDown" disabled={!canNext} onClick={() => onMove(1)}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 6l4 4 4-4" />
            </svg>
          </button>
        </Tip>
      </footer>
    </section>
  );
}

/**
 * The drawer's key facts, a column left of the section content (under the tabs): status, time,
 * latency, sizes, app, environment, consumer and trace id, each a small muted label over its value
 * (mono, cut with an ellipsis, the whole value in its title). On phones they wrap in two columns
 * above the content.
 */
function Facts({ r, tz, project, api }: { r: RequestRow; tz: string; project: string; api: FilterApi }) {
  const app = useAppName(r.app_id);
  const cls = statusClass(r.status_code);
  const at = Date.parse(r.timestamp);
  const facts: [string, ReactNode, string][] = [
    ["Status", <span key="s" className={`exl-status exl-status--${cls}`}>{r.status_code} {reasonPhrase(r.status_code)}</span>, statusText(r.status_code)],
    ["Time", Number.isNaN(at) ? r.timestamp : stampText(at, tz), formatExact(r.timestamp, tz)],
    ["Latency", <span key="l" className={`exl-lat--${latencyTone(r.response_time_ms)}`}>{formatLatency(r.response_time_ms)}</span>, `${r.response_time_ms} ms`],
    ["Sent · received", `${formatBytes(r.request_size)} · ${formatBytes(r.response_size)}`, `Request ${r.request_size ?? 0} B, response ${r.response_size ?? 0} B`],
    ["App", app ?? r.app_id ?? "", app ?? r.app_id ?? ""],
    ["Environment", r.environment, r.environment],
    ["Consumer", r.consumer_id ? <ConsumerHover key="c" project={project} r={r} api={api} /> : (consumerOf(r) ?? ""), ""],
    ["Trace ID", r.trace_id, r.trace_id],
  ];
  return (
    <dl className="exd-facts">
      {facts.map(([k, v, title]) => (
        <div key={k} className="exd-fact">
          <dt>{k}</dt>
          <dd title={title || undefined}>{v === "" || v === null || v === undefined ? <span className="exl-faint">–</span> : v}</dd>
        </div>
      ))}
    </dl>
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

// ---------------------------------------------------------------- sections

/**
 * One titled block of a section (Supabase's sheet blocks): a 28px header row holding the title,
 * its facts after middots (`Headers · 9`, `Body · 260 B · application/json`) and its actions on
 * the right, then the content. Blocks are 16px apart with a hairline between them.
 */
function Block({ title, meta = [], actions, tone, children }: { title: string; meta?: (string | null | undefined | false)[]; actions?: ReactNode; tone?: "error"; children: ReactNode }) {
  const facts = meta.filter((m): m is string => Boolean(m));
  return (
    <section className={`rd-block${tone ? ` rd-block--${tone}` : ""}`} aria-label={title}>
      <header className="rd-block__h">
        <h3 className="rd-block__title">{title}</h3>
        {facts.map((m) => (
          <span key={m} className="rd-block__meta">
            {m}
          </span>
        ))}
        {actions ? <span className="rd-block__actions">{actions}</span> : null}
      </header>
      {children}
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

/** A value that is JSON (`{"same":true}`), parsed, or undefined. */
function jsonValue(text: string): unknown {
  const t = text.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/** A JSON value on one line, tinted as the JSON viewer is (keys, strings, numbers, punctuation). */
function InlineJson({ value }: { value: unknown }) {
  const out: ReactNode[] = [];
  let n = 0;
  const walk = (v: unknown) => {
    if (v === null) out.push(<span key={n++} className="rd-j-null">null</span>);
    else if (typeof v === "string") out.push(<span key={n++} className="rd-j-str"><Marked text={JSON.stringify(v)} /></span>);
    else if (typeof v === "number" || typeof v === "boolean") out.push(<span key={n++} className={`rd-j-${typeof v}`}>{String(v)}</span>);
    else if (Array.isArray(v)) {
      out.push(<span key={n++} className="rd-j-punc">[</span>);
      v.forEach((x, i) => {
        if (i) out.push(<span key={n++} className="rd-j-punc">, </span>);
        walk(x);
      });
      out.push(<span key={n++} className="rd-j-punc">]</span>);
    } else if (typeof v === "object") {
      out.push(<span key={n++} className="rd-j-punc">{"{"}</span>);
      Object.entries(v as Record<string, unknown>).forEach(([k, x], i) => {
        if (i) out.push(<span key={n++} className="rd-j-punc">, </span>);
        out.push(<span key={n++} className="rd-j-key">{JSON.stringify(k)}</span>, <span key={n++} className="rd-j-punc">: </span>);
        walk(x);
      });
      out.push(<span key={n++} className="rd-j-punc">{"}"}</span>);
    }
  };
  walk(value);
  return <code className="rd-inline-json">{out}</code>;
}

/** A key/value value: inline JSON when it is JSON, else text with the SDK's markers as badges. */
function KvValue({ text }: { text: string }) {
  const json = jsonValue(text);
  if (json !== undefined) return <InlineJson value={json} />;
  if (text === "") return <span className="exl-faint">empty</span>;
  return <Marked text={text} />;
}

/**
 * Key/value rows (headers, query parameters, form fields, attributes): names in a fixed muted
 * column, values in mono that wrap anywhere, a copy button on hover or focus of a row.
 */
function KvTable({ pairs, label }: { pairs: [string, string][]; label: string }) {
  return (
    <dl className="rd-kv" aria-label={label}>
      {pairs.map(([k, v], i) => (
        <div key={`${k}#${i}`} className="rd-kv__row">
          <dt title={k}>{k || <span className="exl-faint">(unnamed)</span>}</dt>
          <dd>
            <span className="rd-kv__v">
              <KvValue text={v} />
            </span>
            <CopyButton text={v} label={k || label} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Headers as a JSON object (a repeated name keeps its values in an array), for Copy. */
function headersJson(pairs: [string, string][]): string {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of pairs) {
    const had = out[k];
    out[k] = had === undefined ? v : Array.isArray(had) ? [...had, v] : [had, v];
  }
  return JSON.stringify(out, null, 2);
}

/** A 20px copy button (lib/clipboard), a check for a second once copied. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(() => setDone(false), 1000);
    return () => window.clearTimeout(t);
  }, [done]);
  return (
    <Tip label={done ? "Copied" : `Copy ${label}`}>
      <button type="button" className={`rd-copy${done ? " is-done" : ""}`} aria-label={done ? `Copied ${label}` : `Copy ${label}`} onClick={() => copyText(text).then((ok) => ok && setDone(true))}>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          {done ? <path d="M3.5 8.5l3 3 6-7" /> : <path d="M5.5 5.5h7v7h-7zM10.5 5.5v-2h-7v7h2" />}
        </svg>
      </button>
    </Tip>
  );
}

/** "Not captured" and "No … body" lines, set apart from data. */
function Empty({ children }: { children: ReactNode }) {
  return <p className="rd-none">{children}</p>;
}

/**
 * The Request tab (#1061, redesigned in b5): Overview fixed at the top (then the query parameters
 * and attributes when there are any), and under it Headers | Body (HeadersBodyTabs).
 */
function RequestTab({ data, project, api }: { data: RequestDetailRead; project: string; api: FilterApi }) {
  const r = data.request;
  const fa = (field: Parameters<typeof filterActions>[1], value: string) => (value ? filterActions(api, field, value) : []);
  const minute = sameWindow(r.timestamp, "minute");
  const hour = sameWindow(r.timestamp, "hour");
  const timeActions: FieldAction[] = [
    ...(minute ? [{ label: "Same minute", run: () => api.setWindow(minute.from, minute.to) }] : []),
    ...(hour ? [{ label: "Same hour", run: () => api.setWindow(hour.from, hour.to) }] : []),
  ];
  const tz = useTimeZone();
  const query = queryPairs(r.raw_path);
  const url = r.base_url ? `${r.base_url.replace(/\/+$/, "")}${r.raw_path}` : r.raw_path;
  const attrs = Object.entries(r.attributes ?? {});

  const sampled = isSampledOut(r);

  return (
    <div className="rd-blocks">
      <Block title="Overview">
        <dl className="exd-dl">
          <Field label="Route" copy={r.path} actions={[...fa("path", r.path), { label: "Open endpoint", href: endpointHref(project, { method: r.method, path: r.path }, { range: "24h" }) }]}>
            <code>
              {r.method.toUpperCase()} {r.path}
            </code>
          </Field>
          <Field label="URL" copy={url} actions={fa("url", r.raw_path)}>
            <code>{url}</code>
          </Field>
          <Field label="Time" copy={r.timestamp} actions={timeActions}>
            <code>{formatExact(r.timestamp, tz)}</code>
          </Field>
          <Field label="Body">{r.request_size || contentTypeOf(r.request_headers) ? <code>{[r.request_size ? formatBytes(r.request_size) : null, contentTypeOf(r.request_headers) || null].filter(Boolean).join(" · ")}</code> : null}</Field>
          <Field label="Client IP" copy={r.ip_address} actions={fa("ip", r.ip_address ?? "")}>
            {r.ip_address ? <code>{r.ip_address}</code> : null}
          </Field>
          <Field label="User agent" copy={r.user_agent} actions={fa("user_agent", r.user_agent)}>
            {r.user_agent ? <code>{r.user_agent}</code> : null}
          </Field>
          <Field
            label="Trace ID"
            copy={r.trace_id}
            actions={r.trace_id ? [{ label: "Show this trace’s requests", run: () => api.setConds([...api.conds.filter((c) => c.field !== "trace_id"), { field: "trace_id", op: "eq", value: r.trace_id }]) }, ...fa("trace_id", r.trace_id).slice(1)] : []}
          >
            {r.trace_id ? <code>{r.trace_id}</code> : null}
          </Field>
          <Field label="Release" copy={r.release}>
            {r.release ? <code>{r.release}</code> : null}
          </Field>
          <Field label="Commit" copy={r.commit}>
            {r.commit ? <code>{r.commit}</code> : null}
          </Field>
        </dl>
      </Block>
      {attrs.length ? (
        <Block title="Attributes" meta={[String(attrs.length)]}>
          <KvTable pairs={attrs} label="Request attributes" />
        </Block>
      ) : null}
      <HeadersBodyTabs what="request" headersText={r.request_headers} body={r.request_body} size={r.request_size} first="headers" query={query} sampled={sampled} />
    </div>
  );
}

/**
 * The Response tab (#1061, redesigned in b5), shaped as the Request tab: an Overview (status,
 * latency, body size and type), a failure's Error, validation errors and exception (#988), then
 * Body | Headers (HeadersBodyTabs, Body first). The body is not repeated inside the Error block.
 */
function ResponseTab({ data, api }: { data: RequestDetailRead; api: FilterApi }) {
  const r = data.request;
  const exc = useMemo(() => exceptionLog(data.logs ?? []), [data.logs]);
  const excInfo = exc ? { type: exc.attributes?.["exception.type"], message: exc.attributes?.["exception.message"] } : null;
  const summary = errorSummary(r, excInfo);
  const validation = r.validation_errors ?? [];
  // The Body block shows the response body; the Error block repeats it only when that block can't.
  const bodyBelow = !isSampledOut(r) && Boolean(r.response_body);

  return (
    <div className="rd-blocks">
      <Block title="Overview">
        <dl className="exd-dl">
          <Field label="Status" copy={String(r.status_code)} actions={filterActions(api, "status", String(r.status_code))}>
            <span className={`exl-status exl-status--${statusClass(r.status_code)}`}>{statusText(r.status_code)}</span>
          </Field>
          <Field label="Latency" copy={String(r.response_time_ms)}>
            <span className={`exl-lat--${latencyTone(r.response_time_ms)}`}>{formatLatency(r.response_time_ms)}</span>
          </Field>
          <Field label="Body">{r.response_size || contentTypeOf(r.response_headers) ? <code>{[r.response_size ? formatBytes(r.response_size) : null, contentTypeOf(r.response_headers) || null].filter(Boolean).join(" · ")}</code> : null}</Field>
        </dl>
      </Block>
      {summary ? (
        <Block title="Error" tone="error">
          <div className="exd-error">
            <p className="exd-error__title">{summary.title}</p>
            {summary.detail ? <p className="exd-error__detail">{summary.detail}</p> : null}
            {summary.body && !bodyBelow ? <ErrorBody text={r.response_body} start={summary.body} more={summary.more} /> : null}
          </div>
        </Block>
      ) : null}
      {validation.length ? (
        <Block title="Validation" meta={[`${validation.length} ${validation.length === 1 ? "field" : "fields"}`]} tone="error">
          <ValidationTable errors={validation} />
        </Block>
      ) : null}
      {exc ? (
        <Block title="Exception" tone="error">
          <ExceptionView label="Exception" payload={exc.payload || exc.message} type={excInfo?.type} message={excInfo?.message} />
        </Block>
      ) : null}
      <HeadersBodyTabs what="response" headersText={r.response_headers} body={r.response_body} size={r.response_size} first="body" sampled={isSampledOut(r)} />
    </div>
  );
}

/**
 * Headers (Query parameters) and Body as nested tabs, Postman's way: the tab row holds only the
 * tabs, then at its end the open tab's view switch: Table / Pretty / Fields / Events, or Raw (the
 * headers and parameters as JSON, the body as stored). Copy is only in Raw, in its box's top bar. The body's size and type are in the Overview.
 * Request opens on Headers, Response on Body. ←/→ switch.
 */
function HeadersBodyTabs({
  what,
  headersText,
  body,
  size,
  first,
  query,
  sampled = false,
}: {
  what: "request" | "response";
  headersText: string;
  body: string;
  size: number | undefined;
  first: "headers" | "body";
  /** The request's query parameters: a tab of their own on Request, shown (with 0) even when empty. */
  query?: [string, string][];
  /** Sampled out: the tabs stay, each saying its part was not kept. */
  sampled?: boolean;
}) {
  type Sub = "headers" | "query" | "body";
  const [sub, setSub] = useState<Sub>(first);
  const headers = parseHeaders(headersText);
  const parsed = useMemo(() => parseBody(body, contentTypeOf(headersText)), [body, headersText]);
  // A text/event-stream response also reads as its events (the Events view, its default).
  const sse = useMemo(() => (what === "response" && body && isEventStream(contentTypeOf(headersText)) ? parseEventStream(body) : null), [what, body, headersText]);
  // Each tab can be read as stored ("Raw", with its Copy): the body as text, headers and
  // parameters as JSON; the switch says what the other view is.
  const [rawTabs, setRawTabs] = useState<Set<Sub>>(new Set());
  const raw = rawTabs.has(sub);
  const setRaw = (on: boolean) =>
    setRawTabs((m) => {
      const next = new Set(m);
      if (on) next.add(sub);
      else next.delete(sub);
      return next;
    });
  // The view switch only where there is something to switch.
  const view = sampled ? null : sub === "body" ? (sse ? "Events" : bodyViewName(parsed.kind)) : sub === "headers" ? (headers?.length ? "Table" : null) : query?.length ? "Table" : null;
  const id = useId();
  // Every tab is always there, with its count (0 too), so nothing appears or vanishes per request.
  const headersTab = { slug: "headers" as Sub, label: "Headers", n: sampled ? 0 : (headers?.length ?? 0) };
  const queryTab = query ? [{ slug: "query" as Sub, label: "Query parameters", n: sampled ? 0 : query.length }] : [];
  const bodyTab = { slug: "body" as Sub, label: "Body" };
  const tabs: { slug: Sub; label: string; n?: number }[] = first === "body" ? [bodyTab, headersTab, ...queryTab] : [headersTab, ...queryTab, bodyTab];
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const k = tabs.findIndex((x) => x.slug === sub);
    const n = tabs.length;
    const j = e.key === "ArrowRight" ? (k + 1) % n : e.key === "ArrowLeft" ? (k - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (j < 0) return;
    e.preventDefault();
    e.stopPropagation();
    setSub(tabs[j].slug);
    document.getElementById(`${id}-${tabs[j].slug}`)?.focus();
  };
  return (
    <section className="rd-block exd-subsec" aria-label={`${what === "request" ? "Request" : "Response"} headers and body`}>
      <div className="exd-subbar">
        <div className="exd-subtabs" role="tablist" aria-label={`${what === "request" ? "Request" : "Response"} headers and body`} onKeyDown={onKey}>
          {tabs.map((x) => (
            <button
              key={x.slug}
              type="button"
              role="tab"
              id={`${id}-${x.slug}`}
              aria-controls={`${id}-panel`}
              aria-selected={sub === x.slug}
              tabIndex={sub === x.slug ? 0 : -1}
              onClick={() => setSub(x.slug)}
            >
              {x.label}
              {x.n !== undefined ? <span className={`exd-menu__n${x.n === 0 ? " is-zero" : ""}`}>{x.n}</span> : null}
            </button>
          ))}
        </div>
        <span className="exd-subbar__end">
          {view ? (
            <span className="rd-seg" role="group" aria-label={`Show the ${sub === "query" ? "query parameters" : `${what} ${sub}`} as`}>
              <button type="button" aria-pressed={!raw} onClick={() => setRaw(false)}>
                {view}
              </button>
              <button type="button" aria-pressed={raw} onClick={() => setRaw(true)}>
                Raw
              </button>
            </span>
          ) : null}
        </span>
      </div>
      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${sub}`}>
        {sampled ? (
          <Empty>Not kept: this request was sampled out, so the SDK stored a base record without its headers, query parameters or bodies.</Empty>
        ) : sub === "headers" ? (
          headers ? (
            raw ? (
              <RawText text={headersJson(headers)} what={`the ${what} headers as JSON`} />
            ) : (
              <KvTable pairs={headers} label={what === "request" ? "Request headers" : "Response headers"} />
            )
          ) : (
            <Empty>The {what} headers were not captured.</Empty>
          )
        ) : sub === "query" ? (
          !query?.length ? (
            <Empty>No query parameters: the URL has no query string.</Empty>
          ) : raw ? (
            <RawText text={headersJson(query)} what="the query parameters as JSON" />
          ) : (
            <KvTable pairs={query} label="Query parameters" />
          )
        ) : (
          sse && !raw ? (
            <SseEvents parse={sse} renderJson={(v) => <JsonView value={v} />} />
          ) : (
            <BodyView text={body} body={parsed} size={size} what={what} raw={raw} />
          )
        )}
      </div>
    </section>
  );
}

/** The drawer's one Copy for a whole section (Raw's): "⧉ Copy", then "✓ Copied" in place. */
function SectionCopy({ text, what, label = "Copy", disabled }: { text: () => string; what: string; label?: string; disabled?: boolean }) {
  return <CopyAction className="ah-btn ah-btn--ghost ah-btn--sm rd-copybtn" icon="copy" label={label} ariaLabel={`Copy ${what}`} text={text} disabled={disabled} />;
}

/** The start of the response body in the Error block, with Show more. */
function ErrorBody({ text, start, more }: { text: string; start: string; more: boolean }) {
  const [all, setAll] = useState(false);
  // A JSON error body reads best pretty-printed, whole.
  const json = jsonValue(text);
  if (json !== undefined) {
    return (
      <pre className="rd-pre exd-error__body">
        <Marked text={JSON.stringify(json, null, 2)} />
      </pre>
    );
  }
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
 * The Timeline tab: the trace as a tree, spans under their parent and logs under their span,
 * siblings by time. A row is its marker (a span's bar, a log's dot), its name, its place on the
 * waterfall, its duration and its start from the request. The first TIMELINE_FIRST show, then
 * "Show N more" under them. A row opens what it reported (attributes, events, payload).
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
  // The waterfall's scale: from the earliest step (or the request) to the latest end.
  const lo = Math.min(0, ...steps.map((s) => s.offset));
  const hi = Math.max(1, ...steps.map((s) => s.offset + (s.kind === "span" ? s.span.duration_ms : 0)));
  const range = hi - lo;
  const toggle = (i: number) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  const nSpans = steps.filter((s) => s.kind === "span").length;
  return (
    <section className="rd-section exd-tl" aria-label="Timeline">
      <p className="exd-tl__head">
        <span>
          {nSpans} {nSpans === 1 ? "span" : "spans"} · {steps.length - nSpans} {steps.length - nSpans === 1 ? "log" : "logs"}
        </span>
        <span>{formatLatency(range)}</span>
      </p>
      <ol className="exd-rail">
        {shown.map((s, i) => {
          const tone = s.kind === "span" ? (s.failed ? "error" : "plain") : s.level;
          const isOpen = open.has(i);
          const name = s.kind === "span" ? s.span.name || s.span.span_id : s.log.message;
          return (
            <li key={`${s.kind}${s.at}#${i}`} className={`exd-step exd-step--${s.kind} exd-step--${tone}${isOpen ? " is-open" : ""}`}>
              <button type="button" className="exd-step__row" aria-expanded={isOpen} aria-controls={`${id}-${i}`} onClick={() => toggle(i)}>
                <span className="exd-step__name" style={{ paddingLeft: `${s.depth * 14}px` }} title={name}>
                  <span className="exd-step__mark" aria-hidden="true" />
                  {s.kind === "log" && s.level !== "plain" ? <span className="exd-step__lvl">{s.log.level.toLowerCase()}</span> : null}
                  <span className="exd-step__text">{s.kind === "span" ? name : <Marked text={name} />}</span>
                  {s.kind === "span" && s.span.service_name ? <span className="exd-step__svc">{s.span.service_name}</span> : null}
                </span>
                <span className="exd-step__track" aria-hidden="true">
                  <span
                    className={`exd-step__bar${s.kind === "log" ? " is-tick" : ""}`}
                    style={{ left: `${((s.offset - lo) / range) * 100}%`, width: s.kind === "span" ? `max(2px, ${(s.span.duration_ms / range) * 100}%)` : undefined }}
                  />
                </span>
                <span className="exd-step__dur">{s.kind === "span" ? formatLatency(s.span.duration_ms) : ""}</span>
                <span className="exd-step__off">{offsetText(s.offset)}</span>
              </button>
              {isOpen ? (
                <div className="exd-step__detail" id={`${id}-${i}`} style={{ marginLeft: `${s.depth * 14 + 16}px` }}>
                  {s.kind === "span" ? <SpanDetail span={s.span} at={at} /> : <LogDetail log={s.log} />}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      {!all && steps.length > TIMELINE_FIRST ? (
        <button type="button" className="ah-btn ah-btn--secondary ah-btn--sm exd-tl__more" onClick={() => setAll(true)}>
          Show {steps.length - TIMELINE_FIRST} more
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

/** How long a hover waits before the consumer card opens, and before it closes once left. */
const HOVER_OPEN_MS = 250;
const HOVER_CLOSE_MS = 150;

/**
 * The Consumer fact: the consumer's name, which opens a card on hover or focus (read once, when
 * it first opens): who it is (id, group, first and last seen) with "Filter by this consumer" and
 * "Open consumer". The card stays while the pointer is on it; Esc closes it.
 */
function ConsumerHover({ project, r, api }: { project: string; r: RequestRow; api: FilterApi }) {
  const tz = useTimeZone();
  const cid = r.consumer_id;
  const trigger = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const [read, setRead] = useState<ConsumerRead | null>(null);
  const cardId = useId();

  const schedule = (fn: () => void, ms: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(fn, ms);
  };
  const open = () => {
    const b = trigger.current?.getBoundingClientRect();
    if (!b) return;
    setAt({ top: Math.max(8, Math.min(b.top - 8, window.innerHeight - 260)), left: Math.min(b.right + 12, window.innerWidth - 300) });
  };
  const close = () => setAt(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  useEffect(() => {
    if (!at) return;
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
      trigger.current?.focus();
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [at]);

  // Read the consumer the first time the card opens.
  useEffect(() => {
    if (!at || read) return;
    setRead({ kind: "loading" });
    fetch(`/api/projects/${encodeURIComponent(project)}/consumers/${encodeURIComponent(cid)}`, { cache: "no-store", headers: { accept: "application/json" } })
      .then(async (res) => {
        const b = (await res.json().catch(() => null)) as { ok?: boolean; consumer?: Extract<ConsumerRead, { kind: "ok" }>["c"]; code?: string; next?: string } | null;
        if (res.status === 401 && b?.code === "session_expired") return window.location.assign(b.next ?? "/sign-in");
        setRead(b?.ok && b.consumer ? { kind: "ok", c: b.consumer } : b?.code === "not_found" ? { kind: "none" } : { kind: "error" });
      })
      .catch(() => setRead({ kind: "error" }));
  }, [at, read, project, cid]);

  const c = read?.kind === "ok" ? read.c : null;
  const name = c?.consumer_name || r.consumer_name || cid;
  const stay = { onPointerEnter: () => timer.current && clearTimeout(timer.current), onPointerLeave: () => schedule(close, HOVER_CLOSE_MS) };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`exd-consumer-trigger${at ? " is-open" : ""}`}
        aria-expanded={Boolean(at)}
        aria-controls={at ? cardId : undefined}
        onPointerEnter={() => schedule(open, HOVER_OPEN_MS)}
        onPointerLeave={() => schedule(close, HOVER_CLOSE_MS)}
        onFocus={open}
        onBlur={(e) => {
          if (!document.getElementById(cardId)?.contains(e.relatedTarget as Node)) close();
        }}
        onClick={() => (at ? close() : open())}
      >
        {consumerOf(r) ?? cid}
      </button>
      {at
        ? createPortal(
            <div className="exd-ccard" id={cardId} role="dialog" aria-label={`Consumer ${name}`} style={{ top: at.top, left: at.left }} {...stay}>
              <p className="exd-ccard__name">{name}</p>
              {read?.kind === "error" ? <p className="rd-empty">We couldn’t load this consumer just now.</p> : null}
              <dl className="exd-ccard__dl">
                <div>
                  <dt>ID</dt>
                  <dd>
                    <code>{cid}</code>
                  </dd>
                </div>
                {c?.consumer_group || r.consumer_group ? (
                  <div>
                    <dt>Group</dt>
                    <dd>{c?.consumer_group || r.consumer_group}</dd>
                  </div>
                ) : null}
                {c?.first_seen ? (
                  <div>
                    <dt>First seen</dt>
                    <dd>{formatExact(c.first_seen, tz)}</dd>
                  </div>
                ) : null}
                {c?.last_seen ? (
                  <div>
                    <dt>Last seen</dt>
                    <dd>{formatExact(c.last_seen, tz)}</dd>
                  </div>
                ) : null}
                {read?.kind === "loading" ? (
                  <div>
                    <dt>Seen</dt>
                    <dd className="exl-faint">Loading…</dd>
                  </div>
                ) : null}
              </dl>
              <div className="exd-ccard__actions">
                <button
                  type="button"
                  className="ah-btn ah-btn--secondary ah-btn--sm"
                  onClick={() => {
                    close();
                    api.setConds([...api.conds.filter((x) => x.field !== "consumer"), { field: "consumer", op: "eq", value: cid }]);
                  }}
                >
                  Filter by this consumer
                </button>
                <a className="ah-btn ah-btn--ghost ah-btn--sm" href={`${projectHref(project, "consumers")}?consumer=${encodeURIComponent(cid)}`}>
                  Open consumer
                </a>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

// ---------------------------------------------------------------- raw

function RawTab({ data }: { data: RequestDetailRead }) {
  const text = useMemo(() => JSON.stringify(data.request, null, 2), [data.request]);
  return (
    <section className="rd-section" aria-label="Raw request">
      <JsonView value={data.request} copy={{ text: () => text, what: "the request as JSON" }} fill />
    </section>
  );
}

// ---------------------------------------------------------------- bodies

/** Text as stored, in the same box as the JSON viewer: its top bar holds Copy. */
function RawText({ text, what }: { text: string; what: string }) {
  return (
    <div className="rd-json rd-raw">
      <div className="rd-json__bar">
        <SectionCopy text={() => text} what={what} />
      </div>
      <pre className="rd-raw__pre">
        <Marked text={text} />
      </pre>
    </div>
  );
}

/** How a body can be shown besides as stored ("Raw"): its parsed view's name, or null for plain text. */
const bodyViewName = (kind: Body["kind"]) => (kind === "json" ? "Pretty" : kind === "form" ? "Fields" : null);

/**
 * A body, read by its type: JSON as the collapsible viewer, a form's fields, anything else (an
 * event stream too) as stored text; `raw` shows a JSON or form body as stored instead. Its size,
 * type and Copy live elsewhere (the Overview, the tab row). "No request body" when there was none.
 */
function BodyView({ text, body, size, what, raw }: { text: string; body: Body; size: number | undefined; what: "request" | "response"; raw: boolean }) {
  const stored = text ? new Blob([text]).size : 0;
  if (body.kind === "empty") return <Empty>{size ? `The ${what} body (${formatBytes(size)}) was not captured.` : `No ${what} body.`}</Empty>;
  // The SDK keeps bodies up to its capture limit: say when less was stored than was sent, for
  // bodies that may be cut (a JSON or form body that parses is whole; sizes differ by encoding).
  const cut = size !== undefined && stored < size && body.kind === "text" ? <p className="rd-note">Stored {formatBytes(stored)} of the {formatBytes(size)} sent.</p> : null;
  return (
    <div className="rd-bare">
      {cut}
      {raw || body.kind === "text" ? (
        <RawText text={text} what={`the ${what} body`} />
      ) : body.kind === "json" ? (
        <JsonView value={body.value} />
      ) : (
        <KvTable pairs={body.fields} label="Form fields" />
      )}
    </div>
  );
}

/**
 * A JSON tree: containers open and close, and only the lines in view are in the DOM, so a large
 * body scrolls and toggles without jank.
 */
function JsonView({ value, copy, fill = false }: { value: unknown; copy?: { text: () => string; what: string }; fill?: boolean }) {
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

  const height = viewport > 0 ? viewport : Math.min(lines.length * LINE_HEIGHT + 8, 480);
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
        {copy ? <SectionCopy text={copy.text} what={copy.what} /> : null}
      </div>
      <div className={`rd-json__scroll${fill ? " is-fill" : ""}`} ref={scroller} onScroll={onScroll} style={{ height: fill ? `min(${lines.length * LINE_HEIGHT + 8}px, calc(100dvh - 190px))` : Math.min(lines.length * LINE_HEIGHT + 8, 480) }}>
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
  const head = parsed.blocks[0];
  const shownType = type || head?.type || "";
  const shownMessage = message ?? head?.message ?? "";
  return (
    <section ref={sectionRef} className="rd-section rd-exc" aria-label={label} tabIndex={autoFocus ? -1 : undefined}>
      <div className="rd-exc__bar">
        <h3 className="rd-h">{label}</h3>
        <SectionCopy text={() => payload} what="the full exception" disabled={!payload} />
      </div>
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
      {attrs.length ? (
        <>
          <h4 className="rd-h rd-h--sub">Attributes</h4>
          <AttrTable attrs={attrs} label="Span attributes" />
        </>
      ) : null}
      {events.length ? <h4 className="rd-h rd-h--sub">Events</h4> : null}
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
      ) : null}
    </section>
  );
}

function AttrTable({ attrs, label }: { attrs: [string, string][]; label: string }) {
  return <KvTable pairs={attrs} label={label} />;
}

function LogDetail({ log: l }: { log: TraceLog }) {
  const attrs = Object.entries(l.attributes ?? {});
  const payload = l.payload ?? "";
  if (!payload && !attrs.length && l.logger_name !== EXCEPTION_LOGGER) return <p className="rd-empty">This log reported only its message.</p>;
  return (
    <div className="rd-logdetail">
      {l.logger_name === EXCEPTION_LOGGER ? <p className="rd-logdetail__exc">This log is the request’s exception; Response shows it in full.</p> : null}
      {payload ? <RawText text={payload} what="the payload" /> : null}
      {attrs.length ? (
        <>
          <h3 className="rd-h rd-h--sub">Attributes</h3>
          <AttrTable attrs={attrs} label="Log attributes" />
        </>
      ) : null}
    </div>
  );
}
