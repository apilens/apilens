import { describe, expect, it } from "vitest";
import { MAX_EVENTS, isEventStream, parseEventStream, type SseItem } from "./event-stream";

const events = (body: string) => parseEventStream(body).items.filter((i): i is Extract<SseItem, { kind: "event" }> => i.kind === "event");

describe("isEventStream", () => {
  it("matches text/event-stream whatever the case and parameters", () => {
    expect(isEventStream("text/event-stream")).toBe(true);
    expect(isEventStream("Text/Event-Stream; charset=utf-8")).toBe(true);
    expect(isEventStream(" text/event-stream ;charset=UTF-8")).toBe(true);
    expect(isEventStream("application/json")).toBe(false);
    expect(isEventStream("text/event-streams")).toBe(false);
    expect(isEventStream("")).toBe(false);
    expect(isEventStream(undefined)).toBe(false);
  });
});

describe("parseEventStream", () => {
  // The spec's examples (WHATWG HTML, "Server-sent events → Event stream interpretation").
  it("joins multi-line data with \\n and keeps comments", () => {
    const p = parseEventStream(": test stream\n\ndata: first event\nid: 1\n\ndata:second event\nid\n\ndata:  third event\n\n");
    expect(p.items).toEqual([
      { kind: "comment", text: "test stream" },
      { kind: "event", index: 1, type: "message", data: "first event", id: "1" },
      { kind: "event", index: 2, type: "message", data: "second event" },
      { kind: "event", index: 3, type: "message", data: " third event" },
    ]);
    expect(p.eventCount).toBe(3);
    expect(p.truncated).toBe(false);
    expect(p.trailing).toBeUndefined();
    expect(events("data: YHOO\ndata: +2\ndata: 10\n\n")[0].data).toBe("YHOO\n+2\n10");
  });

  it("reads a field without a colon as an empty value, and an empty data: line as an empty event", () => {
    // "data" alone appends an empty line; two of them make "\n".
    expect(events("data\n\ndata\ndata\n\ndata:\n\n").map((e) => e.data)).toEqual(["", "\n", ""]);
  });

  it("removes one leading space only, and none when there is no space", () => {
    expect(events("data:test\n\n")[0].data).toBe("test");
    expect(events("data: test\n\n")[0].data).toBe("test");
    expect(events("data:  test\n\n")[0].data).toBe(" test");
  });

  it("dispatches nothing for a block without data, and resets the type", () => {
    expect(parseEventStream("event: ping\n\ndata: x\n\n").eventCount).toBe(1);
    expect(events("event: ping\n\ndata: x\n\n")[0].type).toBe("message");
  });

  it("splits on CRLF, LF and CR, and drops one leading BOM", () => {
    expect(events("data: a\r\n\r\ndata: b\r\rdata: c\n\n").map((e) => e.data)).toEqual(["a", "b", "c"]);
    expect(events("﻿data: bom\n\n")[0].data).toBe("bom");
    // Only one BOM goes: a second makes the first field name "﻿data", which is ignored.
    expect(events("﻿﻿data: x\n\n")).toEqual([]);
  });

  it("carries the last id over to later events, ignoring ids with NUL", () => {
    const e = events("id: 7\ndata: a\n\ndata: b\n\nid: x\u0000y\ndata: c\n\nid\ndata: d\n\n");
    expect(e.map((x) => x.id)).toEqual(["7", "7", "7", undefined]);
  });

  it("takes retry only when it is all ASCII digits", () => {
    const e = events("retry: 3000\ndata: a\n\nretry: 3s\ndata: b\n\nretry: -1\ndata: c\n\n");
    expect(e.map((x) => x.retry)).toEqual([3000, undefined, undefined]);
  });

  it("sets the type from event: and ignores other fields", () => {
    expect(events("event: update\nfoo: bar\ndata: x\n\n")[0]).toEqual({ kind: "event", index: 1, type: "update", data: "x" });
  });

  it("returns an event the stream ended in the middle of as trailing", () => {
    const p = parseEventStream('data: one\n\nevent: delta\ndata: {"partial":');
    expect(p.eventCount).toBe(1);
    expect(p.trailing).toBe('event: delta\ndata: {"partial":');
    // A last line with its line break but no blank line after it is not dispatched either.
    expect(parseEventStream("data: one\n").trailing).toBe("data: one");
    expect(parseEventStream("data: one\n").eventCount).toBe(0);
  });

  it("parses JSON payloads and leaves everything else, [DONE] included, as text", () => {
    const e = events('data: {"a":1}\n\ndata: [1,2]\n\ndata: {"a":\n\ndata: [DONE]\n\ndata: plain\n\n');
    expect(e[0].json).toEqual({ a: 1 });
    expect(e[1].json).toEqual([1, 2]);
    expect(e[2].json).toBeUndefined();
    expect(e[2].data).toBe('{"a":');
    // No convention is special: [DONE] is an ordinary event with that data.
    expect(e[3]).toEqual({ kind: "event", index: 4, type: "message", data: "[DONE]" });
    expect(e[4].json).toBeUndefined();
  });

  it("stops at the event limit and says it was truncated", () => {
    const p = parseEventStream("data: x\n\n".repeat(MAX_EVENTS + 3));
    expect(p.eventCount).toBe(MAX_EVENTS);
    expect(p.truncated).toBe(true);
  });

  it("stops at the byte limit", () => {
    const p = parseEventStream(`data: ${"x".repeat(3 * 1024 * 1024)}\n\n`);
    expect(p.truncated).toBe(true);
    expect(p.eventCount).toBe(0);
  });

  it("never throws", () => {
    expect(() => parseEventStream("")).not.toThrow();
    expect(parseEventStream("")).toEqual({ items: [], eventCount: 0, truncated: false });
  });
});
