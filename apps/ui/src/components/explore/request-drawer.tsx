"use client";

import { Fragment, type KeyboardEvent, type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { consumerOf, formatBytes, isSampledOut, latencyTone, statusClass } from "@/lib/explore";
import { shownPath } from "@/lib/first-data";
import type { RequestDetail, RequestDetailRead, RequestRow, TraceLog, TraceSpan } from "@/lib/identity";
import {
  DETAIL_LOAD_FAILED,
  DETAIL_NOT_FOUND,
  DRAWER_TABS,
  type DrawerTab,
  type JsonLine,
  MARKER_TITLE,
  allContainers,
  curlCommand,
  defaultExpanded,
  detailRead,
  formatExact,
  jsonLines,
  levelTone,
  markerSegments,
  moveTab,
  offsetMs,
  parseBody,
  parseHeaders,
  requestDetailPath,
  sizeLabel,
  spanFailed,
  spanName,
  waterfall,
} from "@/lib/request-detail";
import { EXCEPTION_LOGGER, type ExceptionBlock, type StackFrame, exceptionLog, frameLocation, parseException } from "@/lib/stack-trace";
import { formatLatency } from "@/lib/traffic";
import { ObIcon } from "../onboarding/ob";

/** Height of one JSON line in px; the viewer's virtual window depends on it, so the CSS uses the same number. */
const LINE_HEIGHT = 20;
/** JSON lines rendered above and below the visible ones. */
const LINE_OVERSCAN = 20;

type Load = { kind: "loading" } | { kind: "detail"; data: RequestDetailRead } | { kind: "not_found" } | { kind: "error" };

/**
 * The request drawer (#588): a side panel over the Explore log for one request, read from
 * `GET /requests/{id}` when it opens. Tabs: Overview, Headers, Request body, Response body,
 * Validation, Trace (a waterfall of the trace's spans) and Logs. Bodies show as a collapsible JSON
 * tree that renders only the lines in view, so a 64 KB body opens at once; the SDK's `[redacted]`,
 * `[masked]` and `...[truncated]` markers are styled apart from real values. Copy as cURL copies
 * the request as stored, redacted values included as markers. A modal `<dialog>`: Escape, the close
 * button and a click outside close it, and focus goes back to the row.
 */
export function RequestDrawer({ project, row, onClose }: { project: string; row: RequestRow & { id: string }; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [tab, setTab] = useState<DrawerTab>("overview");
  /** Set when a log's link opened the Trace tab, so its Exception section takes focus. */
  const [focusException, setFocusException] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const titleId = useId();
  const tabsId = useId();

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  useEffect(() => {
    const ctl = new AbortController();
    setLoad({ kind: "loading" });
    setCopied(null);
    (async () => {
      try {
        const res = await fetch(requestDetailPath(project, row.id), { signal: ctl.signal, cache: "no-store", headers: { accept: "application/json" } });
        const result = detailRead(res.status, await res.json().catch(() => null));
        if (result.kind === "expired") return window.location.assign(result.next);
        setLoad(result.kind === "detail" ? result : result.kind === "not_found" ? result : { kind: "error" });
      } catch (err) {
        if ((err as Error).name !== "AbortError") setLoad({ kind: "error" });
      }
    })();
    return () => ctl.abort();
  }, [project, row.id, attempt]);

  const detail = load.kind === "detail" ? load.data : null;
  const r: RequestRow = detail?.request ?? row;
  const status = statusClass(r.status_code);

  const copyCurl = async () => {
    if (!detail) return;
    try {
      await navigator.clipboard.writeText(curlCommand(detail.request));
      setCopied("Copied the cURL command. Redacted values stay as [redacted].");
    } catch {
      setCopied("Couldn’t copy. Your browser blocked the clipboard.");
    }
  };

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = moveTab(e.key, tab);
    if (next === null) return;
    e.preventDefault();
    setTab(next);
    setFocusException(false);
    document.getElementById(`${tabsId}-${next}-tab`)?.focus();
  };

  const counts: Partial<Record<DrawerTab, number>> = detail
    ? { validation: detail.request.validation_errors?.length ?? 0, trace: detail.spans?.length ?? 0, logs: detail.logs?.length ?? 0 }
    : {};

  return (
    <dialog
      ref={ref}
      className="rd"
      aria-labelledby={titleId}
      onClose={onClose}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) ref.current?.close();
      }}
    >
      <div className="rd-in">
        <header className="rd-head">
          <div className="rd-head__main">
            <h2 id={titleId} className="rd-title">
              <span className="rd-method">{r.method.toUpperCase()}</span> <code title={shownPath(r)}>{shownPath(r)}</code>
            </h2>
            <p className="rd-sub">
              <span className={`ex-status ex-status--${status}`}>{r.status_code}</span>
              <span className={`ex-lat--${latencyTone(r.response_time_ms)}`}>{formatLatency(r.response_time_ms)}</span>
              <time dateTime={r.timestamp}>{formatExact(r.timestamp)}</time>
            </p>
          </div>
          <div className="rd-head__actions">
            <button type="button" className="ah-btn ah-btn--secondary ah-btn--sm" onClick={copyCurl} disabled={!detail} aria-disabled={!detail || undefined}>
              Copy as cURL
            </button>
            <button type="button" className="rd-close" aria-label="Close request details" onClick={() => ref.current?.close()}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
        </header>
        <p className="rd-copied" role="status">
          {copied}
        </p>

        <div className="rd-tabs" role="tablist" aria-label="Request details" onKeyDown={onTabKey}>
          {DRAWER_TABS.map((t) => (
            <button
              key={t.slug}
              type="button"
              role="tab"
              id={`${tabsId}-${t.slug}-tab`}
              aria-controls={`${tabsId}-panel`}
              aria-selected={tab === t.slug}
              tabIndex={tab === t.slug ? 0 : -1}
              onClick={() => {
                setTab(t.slug);
                setFocusException(false);
              }}
            >
              {t.label}
              {counts[t.slug] ? <span className="rd-count">{counts[t.slug]}</span> : null}
            </button>
          ))}
        </div>

        <div className="rd-panel" role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-${tab}-tab`} tabIndex={0}>
          {load.kind === "loading" ? (
            <div className="rd-loading" aria-busy="true" aria-label="Loading the request">
              {[0, 1, 2, 3, 4].map((i) => (
                <span key={i} className="ex-bone" aria-hidden="true" />
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
          ) : (
            <Panel
              tab={tab}
              data={load.data}
              focusException={focusException}
              onShowException={() => {
                setTab("trace");
                setFocusException(true);
              }}
            />
          )}
        </div>
      </div>
    </dialog>
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

function Panel({
  tab,
  data,
  focusException,
  onShowException,
}: {
  tab: DrawerTab;
  data: RequestDetailRead;
  focusException: boolean;
  onShowException: () => void;
}) {
  const r = data.request;
  switch (tab) {
    case "overview":
      return <Overview r={r} />;
    case "headers":
      return isSampledOut(r) ? (
        <Notice>{SAMPLED_OUT}</Notice>
      ) : (
        <>
          <HeaderTable title="Request headers" text={r.request_headers} />
          <HeaderTable title="Response headers" text={r.response_headers} />
        </>
      );
    case "request":
      return isSampledOut(r) ? <Notice>{SAMPLED_OUT}</Notice> : <BodyView text={r.request_body} size={r.request_size} what="request" />;
    case "response":
      return isSampledOut(r) ? <Notice>{SAMPLED_OUT}</Notice> : <BodyView text={r.response_body} size={r.response_size} what="response" />;
    case "validation":
      return <ValidationTable errors={r.validation_errors ?? []} />;
    case "trace":
      return <TraceView spans={data.spans ?? []} logs={data.logs ?? []} at={r.timestamp} traced={Boolean(r.trace_id)} focusException={focusException} />;
    case "logs":
      return <Logs logs={data.logs ?? []} spans={data.spans ?? []} at={r.timestamp} traced={Boolean(r.trace_id)} onShowException={onShowException} />;
  }
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

// ---------------------------------------------------------------- overview

function Overview({ r }: { r: RequestDetail }) {
  const consumer = consumerOf(r);
  const items: [string, ReactNode][] = [
    ["Time", formatExact(r.timestamp)],
    ["Route", <code key="route">{r.path}</code>],
    ["URL", r.raw_path ? <code key="url">{r.base_url ? `${r.base_url.replace(/\/+$/, "")}${r.raw_path}` : r.raw_path}</code> : null],
    ["Status", r.status_code],
    ["Response time", formatLatency(r.response_time_ms)],
    ["Request size", formatBytes(r.request_size)],
    ["Response size", formatBytes(r.response_size)],
    ["Environment", r.environment],
    ["Consumer", consumer ?? <span className="ex-muted">Anonymous</span>],
    ["Consumer group", r.consumer_group],
    ["Client IP", r.ip_address ? <code key="ip">{r.ip_address}</code> : null],
    ["User agent", r.user_agent],
    ["Release", r.release],
    ["Commit", r.commit ? <code key="commit">{r.commit}</code> : null],
    ["Trace ID", r.trace_id ? <code key="trace">{r.trace_id}</code> : null],
  ];
  const attrs = Object.entries(r.attributes ?? {});
  return (
    <>
      {isSampledOut(r) ? <Notice>{SAMPLED_OUT}</Notice> : null}
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
        <section className="rd-section" aria-label="Attributes">
          <h3 className="rd-h">Attributes</h3>
          <dl className="rd-dl">
            {attrs.map(([k, v]) => (
              <div key={k}>
                <dt>
                  <code>{k}</code>
                </dt>
                <dd>
                  <Marked text={v} />
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
    </>
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

function BodyView({ text, size, what }: { text: string; size: number | undefined; what: "request" | "response" }) {
  const body = useMemo(() => parseBody(text), [text]);
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
      ) : (
        <pre className="rd-pre">
          <Marked text={body.text} />
        </pre>
      )}
    </section>
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

// ---------------------------------------------------------------- trace

/**
 * The Trace tab (#924): the request's exception first, when its trace has an `apilens.exception`
 * log, then the waterfall. A span opens its detail below the waterfall: status, attributes and
 * events, an `exception` event rendered like the exception above.
 */
function TraceView({
  spans,
  logs,
  at,
  traced,
  focusException = false,
}: {
  spans: TraceSpan[];
  logs: TraceLog[];
  at: string;
  traced: boolean;
  focusException?: boolean;
}) {
  const exc = useMemo(() => exceptionLog(logs), [logs]);
  return (
    <>
      {exc ? (
        <ExceptionView
          label="Exception"
          payload={exc.payload || exc.message}
          type={exc.attributes?.["exception.type"]}
          message={exc.attributes?.["exception.message"]}
          autoFocus={focusException}
        />
      ) : null}
      <Waterfall spans={spans} at={at} traced={traced} />
    </>
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

function Waterfall({ spans, at, traced }: { spans: TraceSpan[]; at: string; traced: boolean }) {
  const { rows, total } = useMemo(() => waterfall(spans), [spans]);
  const [picked, setPicked] = useState<string | null>(null);
  const detailId = useId();
  if (!rows.length) {
    return <p className="rd-empty">{traced ? "No spans were reported for this request’s trace." : "This request has no trace id, so there is no trace to show."}</p>;
  }
  const span = picked ? spans.find((s) => s.span_id === picked) : undefined;
  return (
    <>
      <section className="rd-section" aria-label="Trace waterfall">
        <p className="rd-meta">
          {rows.length === 1 ? "1 span" : `${rows.length} spans`} over {formatLatency(total)}. Select a span to see its detail.
        </p>
        <ol className="rd-wf">
          {rows.map(({ span: s, depth, offset, width }) => {
            const failed = spanFailed(s);
            const on = picked === s.span_id;
            return (
              <li key={s.span_id} className={`rd-wf__row${failed ? " is-error" : ""}${on ? " is-on" : ""}`}>
                <button type="button" className="rd-wf__btn" aria-pressed={on} aria-controls={on ? detailId : undefined} onClick={() => setPicked(on ? null : s.span_id)}>
                  <span className="rd-wf__name" style={{ paddingLeft: depth * 14 }} title={s.name}>
                    <span>{s.name || s.span_id}</span>
                    {s.service_name ? <span className="rd-wf__svc">{s.service_name}</span> : null}
                  </span>
                  <span className="rd-wf__track">
                    <span className="rd-wf__bar" style={{ left: `${offset}%`, width: `${width}%` }} />
                  </span>
                  <span className="rd-wf__dur">
                    {formatLatency(s.duration_ms)}
                    {failed ? <span className="rd-wf__err">Error</span> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </section>
      {span ? <SpanDetail id={detailId} span={span} at={at} /> : null}
    </>
  );
}

const EXCEPTION_EVENT_KEYS = new Set(["exception.type", "exception.message", "exception.stacktrace"]);

function SpanDetail({ id, span: s, at }: { id: string; span: TraceSpan; at: string }) {
  const items: [string, ReactNode][] = [
    ["Span ID", <code key="id">{s.span_id}</code>],
    ["Kind", s.kind],
    ["Service", s.service_name],
    ["Started", <time key="start" dateTime={s.start} title={formatExact(s.start)}>{offsetMs(s.start, at)}</time>],
    ["Duration", formatLatency(s.duration_ms)],
    ["Status", `${s.status || "unset"}${s.status_code ? ` (${s.status_code})` : ""}`],
    ["Status message", s.status_message ? <Marked key="msg" text={s.status_message} /> : null],
  ];
  const attrs = Object.entries(s.attributes ?? {});
  const events = s.events ?? [];
  return (
    <section id={id} className="rd-section rd-span" aria-label={`Span ${s.name || s.span_id}`}>
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
        <ol className="rd-events">
          {events.map((e, i) => {
            const ea = e.attributes ?? {};
            const isExc = e.name === "exception";
            const rest = Object.entries(ea).filter(([k]) => !isExc || !EXCEPTION_EVENT_KEYS.has(k));
            return (
              <li key={`${e.time}#${i}`} className="rd-event">
                <p className="rd-event__head">
                  <code>{e.name}</code>
                  <time className="rd-num" dateTime={e.time} title={formatExact(e.time)}>
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

// ---------------------------------------------------------------- logs

/**
 * The Logs tab (#925): one row per log, oldest first. A row expands to the log's payload
 * (monospace, scrollable, copied exactly as stored) and its attributes; the `apilens.exception`
 * log links to the Exception section of the Trace tab.
 */
function Logs({
  logs,
  spans,
  at,
  traced,
  onShowException,
}: {
  logs: TraceLog[];
  spans: TraceSpan[];
  at: string;
  traced: boolean;
  onShowException: () => void;
}) {
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  const baseId = useId();
  if (!logs.length) {
    return <p className="rd-empty">{traced ? "No logs were reported for this request’s trace." : "This request has no trace id, so no logs are linked to it."}</p>;
  }
  const toggle = (i: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  return (
    <table className="rd-table rd-table--logs">
      <caption className="rd-cap">Logs of this request’s trace, oldest first. Times are from the start of the request. Select a log to see its payload and attributes.</caption>
      <thead>
        <tr>
          <th scope="col">Time</th>
          <th scope="col">Level</th>
          <th scope="col">Message</th>
        </tr>
      </thead>
      <tbody>
        {logs.map((l, i) => {
          const span = spanName(spans, l);
          const on = open.has(i);
          const detailId = `${baseId}-log-${i}`;
          return (
            <Fragment key={`${l.timestamp}#${i}`}>
              <tr className={on ? "is-open" : undefined}>
                <td className="rd-num">
                  <time dateTime={l.timestamp} title={formatExact(l.timestamp)}>
                    {offsetMs(l.timestamp, at)}
                  </time>
                </td>
                <td>
                  <span className={`rd-level rd-level--${levelTone(l.level)}`}>{l.level || "log"}</span>
                </td>
                <td>
                  <button type="button" className="rd-logbtn" aria-expanded={on} aria-controls={on ? detailId : undefined} onClick={() => toggle(i)}>
                    <svg className="rd-logbtn__chev" viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M6 4l4 4-4 4" />
                    </svg>
                    <span className="rd-logbtn__text">
                      <span className="rd-logmsg">
                        <Marked text={l.message} />
                      </span>
                      {span ? <span className="rd-logspan">in {span}</span> : null}
                    </span>
                  </button>
                </td>
              </tr>
              {on ? (
                <tr className="rd-logrow">
                  <td colSpan={3} id={detailId}>
                    <LogDetail log={l} onShowException={onShowException} />
                  </td>
                </tr>
              ) : null}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function LogDetail({ log: l, onShowException }: { log: TraceLog; onShowException: () => void }) {
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
      {l.logger_name === EXCEPTION_LOGGER ? (
        <p className="rd-logdetail__exc">
          This log is the request’s exception.{" "}
          <button type="button" className="rd-linkbtn" onClick={onShowException}>
            View the exception
          </button>
        </p>
      ) : null}
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
