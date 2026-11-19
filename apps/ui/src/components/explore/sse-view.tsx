"use client";

import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { SseItem, SseParse } from "@/lib/event-stream";
import { CopyAction } from "./copy-action";

/** Rows rendered at first, and added each time the list's end comes into view. */
const WINDOW = 200;

type SseEvent = Extract<SseItem, { kind: "event" }>;

/**
 * A `text/event-stream` body as its events (the body's Events view; Raw shows it as sent). A head
 * line counts events and comments and says when the stream was cut or ended mid-event; then one
 * row per item in the order sent: an event's number, its id and its data on one line, opening to the data (JSON in
 * the JSON viewer, else as sent) with Copy and its retry. Comments are muted lines, `[DONE]` an
 * end-of-stream marker. Only the SSE fields are read, never the data: when the stream sends
 * `event:` types, rows show them (the default `message` muted) and chips filter by them; a
 * data-only stream shows none. ↑/↓ move between rows, Enter opens one. Past WINDOW rows the list renders
 * WINDOW at a time, adding more as its end scrolls into view.
 */
export function SseEvents({ parse, renderJson }: { parse: SseParse; renderJson: (value: unknown) => ReactNode }) {
  const [type, setType] = useState<string | null>(null);
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  const [limit, setLimit] = useState(WINDOW);
  const list = useRef<HTMLOListElement>(null);
  const end = useRef<HTMLLIElement>(null);

  const types = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of parse.items) if (it.kind === "event") m.set(it.type, (m.get(it.type) ?? 0) + 1);
    return [...m];
  }, [parse]);
  const comments = parse.items.length - parse.eventCount;
  // Many streams send only data: lines, so every event is the default "message". Types are shown
  // (badges, and chips when there are two or more) only when the stream used event: types.
  const typed = types.some(([name]) => name !== "message");
  const shown = useMemo(() => (type === null ? parse.items : parse.items.filter((it) => it.kind === "event" && it.type === type)), [parse, type]);
  const rendered = shown.slice(0, limit);

  // Add the next window when the end of the list scrolls into view.
  useEffect(() => {
    const el = end.current;
    if (!el || shown.length <= limit || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setLimit((l) => l + WINDOW);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [shown.length, limit]);

  const toggle = (index: number) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  // ↑/↓ move the focus between event rows; at the last rendered row ↓ renders the next window.
  const onKeyDown = (e: KeyboardEvent<HTMLOListElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = [...(list.current?.querySelectorAll<HTMLButtonElement>("[data-sse-row]") ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    e.stopPropagation();
    const next = at + (e.key === "ArrowDown" ? 1 : -1);
    if (next >= rows.length && shown.length > limit) {
      setLimit((l) => l + WINDOW);
      requestAnimationFrame(() => list.current?.querySelectorAll<HTMLButtonElement>("[data-sse-row]")[next]?.focus());
      return;
    }
    rows[Math.max(0, Math.min(rows.length - 1, next))]?.focus();
  };

  const head = [
    `${parse.eventCount.toLocaleString("en-US")} ${parse.eventCount === 1 ? "event" : "events"}`,
    `${comments.toLocaleString("en-US")} ${comments === 1 ? "comment" : "comments"}`,
    ...(parse.truncated ? ["truncated"] : []),
    ...(parse.trailing !== undefined ? ["ended mid-event"] : []),
  ].join(" · ");

  return (
    <div className="sse">
      <p className="sse-head">{head}</p>
      {typed && types.length > 1 ? (
        <div className="sse-types" role="group" aria-label="Show events of one type">
          {types.map(([name, n]) => (
            <button key={name} type="button" aria-pressed={type === name} onClick={() => setType(type === name ? null : name)}>
              <code>{name}</code>
              <span>{n.toLocaleString("en-US")}</span>
            </button>
          ))}
        </div>
      ) : null}
      <ol className="sse-list" ref={list} onKeyDown={onKeyDown} aria-label="Events in the order they were sent">
        {rendered.map((it, k) => (it.kind === "comment" ? <CommentRow key={`c${k}`} text={it.text} /> : <EventRow key={it.index} e={it} typed={typed} open={open.has(it.index)} onToggle={() => toggle(it.index)} renderJson={renderJson} />))}
        {shown.length > limit ? (
          <li ref={end} className="sse-more">
            <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={() => setLimit((l) => l + WINDOW)}>
              Show {Math.min(WINDOW, shown.length - limit).toLocaleString("en-US")} more of {(shown.length - limit).toLocaleString("en-US")}
            </button>
          </li>
        ) : null}
        {type === null && parse.trailing !== undefined && shown.length <= limit ? (
          <li className="sse-row sse-row--trailing">
            <p className="sse-note">The stream ended in the middle of an event, which was never dispatched:</p>
            <pre className="sse-pre">{parse.trailing}</pre>
          </li>
        ) : null}
      </ol>
    </div>
  );
}

function CommentRow({ text }: { text: string }) {
  return (
    <li className="sse-row sse-row--comment">
      <span className="sse-comment">: {text}</span>
    </li>
  );
}

const preview = (data: string) => data.replace(/\s+/g, " ").trim();

function EventRow({ e, typed, open, onToggle, renderJson }: { e: SseEvent; typed: boolean; open: boolean; onToggle: () => void; renderJson: (value: unknown) => ReactNode }) {
  if (e.sentinel) {
    return (
      <li className="sse-row sse-row--end">
        <span className="sse-n">#{e.index}</span>
        <code className="sse-data">{e.data}</code>
        <span className="sse-endnote">end of stream</span>
      </li>
    );
  }
  return (
    <li className={`sse-row${open ? " is-open" : ""}`}>
      <button type="button" className="sse-row__btn" data-sse-row aria-expanded={open} onClick={onToggle}>
        <svg className="sse-chev" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M6 4l4 4-4 4" />
        </svg>
        <span className="sse-n">#{e.index}</span>
        {typed ? <code className={`sse-type${e.type === "message" ? " is-default" : ""}`}>{e.type}</code> : null}
        {e.id !== undefined ? <span className="sse-id">id {e.id}</span> : null}
        <span className="sse-data">{preview(e.data) || <span className="sse-empty">empty</span>}</span>
      </button>
      {open ? (
        <div className="sse-detail">
          <div className="sse-detail__bar">
            {e.retry !== undefined ? <span className="sse-retry">retry {e.retry.toLocaleString("en-US")} ms</span> : <span />}
            <CopyAction className="ah-btn ah-btn--ghost ah-btn--sm rd-copybtn" icon="copy" label="Copy" ariaLabel={`Copy the data of event ${e.index}`} text={() => e.data} />
          </div>
          {e.json !== undefined ? renderJson(e.json) : <pre className="sse-pre">{e.data}</pre>}
        </div>
      ) : null}
    </li>
  );
}
