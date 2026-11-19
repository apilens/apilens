// Server-sent events, read as the WHATWG HTML standard parses them ("Server-sent events →
// Parsing an event stream"), for showing a stored `text/event-stream` body event by event. Only
// the standard's fields are read (event, data, id, retry); nothing inside the data is assumed,
// and no vendor is detected. Pure, no React; see event-stream.test.ts.

/** One item of a parsed stream: a dispatched event, or a comment line (`: keep-alive`). */
export type SseItem =
  | {
      kind: "event";
      /** 1-based, in the order the events were dispatched. */
      index: number;
      /** The `event` field, "message" when the stream sent none. */
      type: string;
      /** The data lines joined with "\n". */
      data: string;
      /** The last event id in force when the event was dispatched (it carries over), when any. */
      id?: string;
      /** A `retry` field of all ASCII digits sent with this event, in ms. */
      retry?: number;
      /** The data parsed as JSON, when it is an object or array that parses. */
      json?: unknown;
      /** The data is `[DONE]`, OpenAI's end-of-stream marker. */
      sentinel?: boolean;
    }
  | { kind: "comment"; text: string };

export type SseParse = {
  items: SseItem[];
  eventCount: number;
  /** The lines of an event the stream ended in the middle of (never dispatched), when any. */
  trailing?: string;
  /** Parsing stopped at MAX_EVENTS events or MAX_BYTES bytes. */
  truncated: boolean;
};

/** The most events, and bytes of body, one parse reads. */
export const MAX_EVENTS = 5000;
export const MAX_BYTES = 2 * 1024 * 1024;

/** Whether a content type is `text/event-stream`, ignoring case and parameters (`; charset=utf-8`). */
export function isEventStream(contentType: string | null | undefined): boolean {
  return (contentType ?? "").split(";")[0].trim().toLowerCase() === "text/event-stream";
}

const DIGITS = /^[0-9]+$/;

/**
 * Parses a stored event stream. The body is already UTF-8 text; one leading BOM is dropped.
 * Lines end in CRLF, LF or CR; an empty line dispatches the event being built, unless its data is
 * empty. At the end of the input an unfinished event is not dispatched: its lines come back as
 * `trailing`. Never throws.
 */
export function parseEventStream(body: string): SseParse {
  let text = body.startsWith("﻿") ? body.slice(1) : body;
  let truncated = false;
  if (text.length > MAX_BYTES / 4) {
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > MAX_BYTES) {
      text = new TextDecoder().decode(bytes.slice(0, MAX_BYTES));
      truncated = true;
    }
  }

  const items: SseItem[] = [];
  let eventCount = 0;
  let type = "";
  let data = "";
  let lastId = "";
  let retry: number | undefined;
  // The raw lines of the event being built, for `trailing`.
  let pending: string[] = [];

  // Every line but the last ended in a line break; the last is what followed the final break
  // ("" when the body ends in one), an unterminated line the stream stopped in.
  const lines = text.split(/\r\n|\n|\r/);
  const unterminated = lines.pop() ?? "";

  for (const line of lines) {
    if (line === "") {
      // Dispatch.
      if (data !== "") {
        if (eventCount >= MAX_EVENTS) {
          truncated = true;
          pending = [];
          break;
        }
        const value = data.endsWith("\n") ? data.slice(0, -1) : data;
        const event: Extract<SseItem, { kind: "event" }> = { kind: "event", index: ++eventCount, type: type || "message", data: value };
        if (lastId !== "") event.id = lastId;
        if (retry !== undefined) event.retry = retry;
        const t = value.trim();
        if (t.startsWith("{") || t.startsWith("[")) {
          try {
            event.json = JSON.parse(value);
          } catch {
            // Not JSON after all (or cut): shown as text.
          }
        }
        if (t === "[DONE]") event.sentinel = true;
        items.push(event);
      }
      type = "";
      data = "";
      retry = undefined;
      pending = [];
      continue;
    }
    if (line.startsWith(":")) {
      const c = line.slice(1);
      items.push({ kind: "comment", text: c.startsWith(" ") ? c.slice(1) : c });
      continue;
    }
    pending.push(line);
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        type = value;
        break;
      case "data":
        data += `${value}\n`;
        break;
      case "id":
        if (!value.includes("\u0000")) lastId = value;
        break;
      case "retry":
        if (DIGITS.test(value)) retry = Number(value);
        break;
      default:
      // Other fields are ignored.
    }
  }

  if (unterminated !== "" && !truncated) pending.push(unterminated);
  const rest = pending.join("\n");
  return { items, eventCount, ...(rest.trim() !== "" ? { trailing: rest } : {}), truncated };
}
