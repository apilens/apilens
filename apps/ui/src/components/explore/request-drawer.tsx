"use client";

import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
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
              onClick={() => setTab(t.slug)}
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
            <Panel tab={tab} data={load.data} />
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

function Panel({ tab, data }: { tab: DrawerTab; data: RequestDetailRead }) {
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
      return <Waterfall spans={data.spans ?? []} traced={Boolean(r.trace_id)} />;
    case "logs":
      return <Logs logs={data.logs ?? []} spans={data.spans ?? []} at={r.timestamp} traced={Boolean(r.trace_id)} />;
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

function Waterfall({ spans, traced }: { spans: TraceSpan[]; traced: boolean }) {
  const { rows, total } = useMemo(() => waterfall(spans), [spans]);
  if (!rows.length) {
    return <p className="rd-empty">{traced ? "No spans were reported for this request’s trace." : "This request has no trace id, so there is no trace to show."}</p>;
  }
  return (
    <section className="rd-section" aria-label="Trace waterfall">
      <p className="rd-meta">
        {rows.length === 1 ? "1 span" : `${rows.length} spans`} over {formatLatency(total)}
      </p>
      <ol className="rd-wf">
        {rows.map(({ span: s, depth, offset, width }) => {
          const failed = spanFailed(s);
          return (
            <li key={s.span_id} className={`rd-wf__row${failed ? " is-error" : ""}`}>
              <div className="rd-wf__name" style={{ paddingLeft: depth * 14 }} title={s.name}>
                <span>{s.name || s.span_id}</span>
                {s.service_name ? <span className="rd-wf__svc">{s.service_name}</span> : null}
              </div>
              <div className="rd-wf__track">
                <span className="rd-wf__bar" style={{ left: `${offset}%`, width: `${width}%` }} />
              </div>
              <div className="rd-wf__dur">
                {formatLatency(s.duration_ms)}
                {failed ? <span className="rd-wf__err">Error</span> : null}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------- logs

function Logs({ logs, spans, at, traced }: { logs: TraceLog[]; spans: TraceSpan[]; at: string; traced: boolean }) {
  if (!logs.length) {
    return <p className="rd-empty">{traced ? "No logs were reported for this request’s trace." : "This request has no trace id, so no logs are linked to it."}</p>;
  }
  return (
    <table className="rd-table rd-table--logs">
      <caption className="rd-cap">Logs of this request’s trace, oldest first. Times are from the start of the request.</caption>
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
          return (
            <tr key={`${l.timestamp}#${i}`}>
              <td className="rd-num">
                <time dateTime={l.timestamp} title={formatExact(l.timestamp)}>
                  {offsetMs(l.timestamp, at)}
                </time>
              </td>
              <td>
                <span className={`rd-level rd-level--${levelTone(l.level)}`}>{l.level || "log"}</span>
              </td>
              <td>
                <span className="rd-logmsg">
                  <Marked text={l.message} />
                </span>
                {span ? <span className="rd-logspan">in {span}</span> : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
