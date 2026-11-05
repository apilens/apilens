import { describe, expect, it } from "vitest";
import type { TraceSpan } from "./identity";
import {
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
  shellQuote,
  sizeLabel,
  spanFailed,
  waterfall,
} from "./request-detail";

describe("markerSegments", () => {
  it("splits redacted, masked and truncated markers from the text around them", () => {
    expect(markerSegments("token=[redacted]&x=1")).toEqual([{ text: "token=" }, { text: "[redacted]", marker: "redacted" }, { text: "&x=1" }]);
    expect(markerSegments("[masked]")).toEqual([{ text: "[masked]", marker: "masked" }]);
    expect(markerSegments('{"a": "bbb...[truncated]')).toEqual([{ text: '{"a": "bbb' }, { text: "...[truncated]", marker: "truncated" }]);
    expect(markerSegments("abc…[truncated]")[1]).toEqual({ text: "…[truncated]", marker: "truncated" });
  });

  it("keeps plain text and empty text as one segment", () => {
    expect(markerSegments("plain")).toEqual([{ text: "plain" }]);
    expect(markerSegments("")).toEqual([{ text: "" }]);
    expect(markerSegments("[redacted-ish]")).toEqual([{ text: "[redacted-ish]" }]);
  });
});

describe("parseHeaders", () => {
  it("reads a stored JSON object in order, joining arrays", () => {
    expect(parseHeaders('{"Content-Type":"application/json","Authorization":"[redacted]","Accept":["a","b"],"X-N":3}')).toEqual([
      ["Content-Type", "application/json"],
      ["Authorization", "[redacted]"],
      ["Accept", "a, b"],
      ["X-N", "3"],
    ]);
  });

  it("is null when nothing was captured and keeps unreadable text as one row", () => {
    expect(parseHeaders("")).toBeNull();
    expect(parseHeaders("  ")).toBeNull();
    expect(parseHeaders("not json")).toEqual([["", "not json"]]);
  });
});

describe("parseBody", () => {
  it("parses JSON containers and keeps everything else as text", () => {
    expect(parseBody("")).toEqual({ kind: "empty" });
    expect(parseBody('{"a":1}')).toEqual({ kind: "json", value: { a: 1 } });
    expect(parseBody(" [1,2]")).toEqual({ kind: "json", value: [1, 2] });
    expect(parseBody("[masked]")).toEqual({ kind: "text", text: "[masked]" });
    expect(parseBody("42")).toEqual({ kind: "text", text: "42" });
    expect(parseBody('{"a": "xx...[truncated]')).toEqual({ kind: "text", text: '{"a": "xx...[truncated]' });
  });
});

describe("jsonLines", () => {
  const value = { user: { name: "Ada", password: "[redacted]" }, tags: ["a"], n: 1, ok: true, none: null, empty: {} };

  it("prints collapsed containers as one line with their size", () => {
    const lines = jsonLines(value, new Set());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ path: "", depth: 0, kind: "collapsed", text: "{…}", size: 6 });
    expect(sizeLabel(lines[0])).toBe("6 keys");
  });

  it("opens the containers in the set, with commas between siblings", () => {
    const lines = jsonLines(value, new Set(["", "/user"]));
    expect(lines.map((l) => [l.depth, l.key ?? null, l.kind, l.text, l.comma])).toEqual([
      [0, null, "open", "{", false],
      [1, "user", "open", "{", false],
      [2, "name", "string", '"Ada"', true],
      [2, "password", "string", '"[redacted]"', false],
      [1, null, "close", "}", true],
      [1, "tags", "collapsed", "[…]", true],
      [1, "n", "number", "1", true],
      [1, "ok", "boolean", "true", true],
      [1, "none", "null", "null", true],
      [1, "empty", "collapsed", "{}", false],
      [0, null, "close", "}", false],
    ]);
    expect(sizeLabel(lines[5])).toBe("1 item");
  });

  it("gives every line a unique path, escaping slashes in keys", () => {
    const v = { "a/b": { c: 1 }, a: { "b~": 2 } };
    const lines = jsonLines(v, allContainers(v));
    const paths = lines.map((l) => l.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toContain("/a~1b/c");
    expect(paths).toContain("/a/b~0");
  });
});

describe("defaultExpanded", () => {
  it("opens a small body fully", () => {
    const v = { a: { b: [1, 2] } };
    expect(defaultExpanded(v)).toEqual(allContainers(v));
  });

  it("opens a 64 KB body only as far as the line budget allows", () => {
    const big = { items: Array.from({ length: 1500 }, (_, i) => ({ id: i, name: `item ${i}`, tags: ["x", "y"] })) };
    expect(JSON.stringify(big).length).toBeGreaterThan(64_000);
    const open = defaultExpanded(big, 400);
    expect(open.has("")).toBe(true);
    // Opening the 1500 items would pass the budget, so they stay one line.
    expect(open.has("/items")).toBe(false);
    expect(jsonLines(big, open).length).toBeLessThanOrEqual(400);
    // Expand all is still possible, and every line is cheap to compute.
    const all = jsonLines(big, allContainers(big));
    expect(all.length).toBeGreaterThan(10_000);
  });
});

describe("curlCommand", () => {
  it("builds the request as stored, with redacted values left as markers", () => {
    const cmd = curlCommand({
      method: "post",
      path: "/orders",
      raw_path: "/orders?token=[redacted]",
      base_url: "https://api.example.com/",
      request_headers: '{"Authorization":"[redacted]","Content-Type":"application/json","Content-Length":"12","Host":"api.example.com"}',
      request_body: '{"note":"it\'s"}',
    });
    expect(cmd).toBe(
      [
        "curl -X POST 'https://api.example.com/orders?token=[redacted]'",
        "-H 'Authorization: [redacted]'",
        "-H 'Content-Type: application/json'",
        `--data-raw '{"note":"it'\\''s"}'`,
      ].join(" \\\n  "),
    );
  });

  it("uses the Host header without a base URL, else the path alone", () => {
    expect(curlCommand({ method: "GET", path: "/a", raw_path: "", base_url: "", request_headers: '{"host":"h.example.com"}', request_body: "" })).toBe(
      "curl -X GET 'https://h.example.com/a'",
    );
    expect(curlCommand({ method: "GET", path: "/a", raw_path: "/a?x=1", base_url: "", request_headers: "", request_body: "" })).toBe("curl -X GET '/a?x=1'");
  });

  it("quotes single quotes for a POSIX shell", () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
  });
});

function span(id: string, parent: string, startMs: number, dur: number, extra: Partial<TraceSpan> = {}): TraceSpan {
  return {
    span_id: id,
    parent_span_id: parent,
    name: id,
    kind: "internal",
    service_name: "shop",
    start: new Date(Date.UTC(2026, 10, 5, 12, 0, 0, startMs)).toISOString(),
    duration_ms: dur,
    status: "ok",
    status_code: 0,
    attributes: {},
    ...extra,
  };
}

describe("waterfall", () => {
  it("orders parents before children and places bars against the whole trace", () => {
    const { rows, total } = waterfall([span("db", "root", 10, 40), span("root", "", 0, 100), span("cache", "root", 5, 5), span("q", "db", 20, 10)]);
    expect(total).toBe(100);
    expect(rows.map((r) => [r.span.span_id, r.depth])).toEqual([
      ["root", 0],
      ["cache", 1],
      ["db", 1],
      ["q", 2],
    ]);
    expect(rows[2]).toMatchObject({ offset: 10, width: 40 });
  });

  it("treats spans with an unknown parent as roots and keeps every span", () => {
    const { rows } = waterfall([span("a", "missing", 0, 10), span("b", "c", 0, 1), span("c", "b", 0, 1)]);
    expect(rows.map((r) => r.span.span_id).sort()).toEqual(["a", "b", "c"]);
  });

  it("is empty without spans and full width for a zero-length trace", () => {
    expect(waterfall([])).toEqual({ rows: [], total: 0 });
    expect(waterfall([span("a", "", 0, 0)]).rows[0]).toMatchObject({ offset: 0, width: 100 });
  });
});

describe("small readers", () => {
  it("knows failed spans and log tones", () => {
    expect(spanFailed({ status: "ERROR", status_code: 0 })).toBe(true);
    expect(spanFailed({ status: "ok", status_code: 503 })).toBe(true);
    expect(spanFailed({ status: "ok", status_code: 200 })).toBe(false);
    expect(levelTone("ERROR")).toBe("error");
    expect(levelTone("warning")).toBe("warn");
    expect(levelTone("info")).toBe("plain");
  });

  it("formats exact times and offsets", () => {
    expect(formatExact("2026-11-05T14:03:12.345Z")).toBe("Nov 5, 2026, 14:03:12.345 UTC");
    expect(formatExact("nope")).toBe("");
    expect(offsetMs("2026-11-05T14:03:12.357Z", "2026-11-05T14:03:12.345Z")).toBe("+12.0 ms");
    expect(offsetMs("2026-11-05T14:03:12.340Z", "2026-11-05T14:03:12.345Z")).toBe("−5.0 ms");
  });

  it("moves between tabs with arrows, Home and End", () => {
    expect(moveTab("ArrowRight", "overview")).toBe("headers");
    expect(moveTab("ArrowLeft", "overview")).toBe("logs");
    expect(moveTab("End", "headers")).toBe("logs");
    expect(moveTab("Home", "logs")).toBe("overview");
    expect(moveTab("Enter", "logs")).toBeNull();
  });

  it("encodes the Route Handler path", () => {
    expect(requestDetailPath("shop", "MTc_x-1")).toBe("/api/projects/shop/requests/MTc_x-1");
  });
});

describe("detailRead", () => {
  const request = { id: "x" };
  it("reads the detail, defaulting missing spans and logs", () => {
    expect(detailRead(200, { ok: true, detail: { request, spans: null } })).toEqual({ kind: "detail", data: { request, spans: [], logs: [] } });
  });

  it("reads not found, an expired session and other failures", () => {
    expect(detailRead(404, { ok: false, code: "not_found" })).toEqual({ kind: "not_found" });
    expect(detailRead(401, { ok: false, code: "session_expired", next: "/auth/refresh" })).toEqual({ kind: "expired", next: "/auth/refresh" });
    expect(detailRead(503, null)).toEqual({ kind: "error", code: "unavailable" });
    expect(detailRead(200, { ok: true })).toEqual({ kind: "error", code: "network_error" });
  });
});
