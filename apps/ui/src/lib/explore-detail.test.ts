import { describe, expect, it } from "vitest";
import {
  errorSummary,
  exportFileName,
  leadSection,
  neighborId,
  offsetText,
  queryPairs,
  rangeKeys,
  sameWindow,
  timelineSteps,
  toCsv,
  toJson,
  windowAround,
} from "./explore-detail";
import type { RequestRow, TraceLog, TraceSpan } from "./identity";

const req = (code: number, body = "", errors: { loc: string; msg: string; type: string }[] | null = null) => ({ status_code: code, response_body: body, validation_errors: errors });

describe("leadSection", () => {
  it("leads with validation, then the exception, then the response body", () => {
    expect(leadSection(req(422, "{}", [{ loc: "body.qty", msg: "must be positive", type: "value_error" }]), true)).toBe("validation");
    expect(leadSection(req(500, "oops"), true)).toBe("exception");
    expect(leadSection(req(404, '{"error":"not found"}'), false)).toBe("response");
    expect(leadSection(req(404, "  "), false)).toBe("summary");
    expect(leadSection(req(200, "{}"), false)).toBe("summary");
  });
});

describe("errorSummary", () => {
  it("names the reason, the first validation message and the start of the body", () => {
    const s = errorSummary(req(422, "x".repeat(400), [{ loc: "body.qty", msg: "must be positive", type: "value_error" }]), null);
    expect(s).toEqual({ title: "422 Unprocessable Content", detail: "body.qty: must be positive", body: "x".repeat(300), more: true });
    expect(errorSummary(req(500, "boom"), { type: "ValueError", message: "bad" })).toEqual({ title: "500 Internal Server Error", detail: "ValueError: bad", body: "boom", more: false });
    expect(errorSummary(req(200, "ok"), null)).toBeNull();
  });
});

describe("timelineSteps", () => {
  const span = (start: string, status = "ok", code = 0) => ({ span_id: start, parent_span_id: "", name: "db", kind: "", service_name: "", start, duration_ms: 3, status, status_code: code, status_message: "", attributes: null, events: null, links: null }) as TraceSpan;
  const log = (timestamp: string, level: string) => ({ timestamp, level, message: "m", logger_name: "", span_id: "", payload: "", attributes: null }) as TraceLog;
  it("puts spans and logs on one rail with offsets from the request", () => {
    const steps = timelineSteps([span("2026-11-05T10:00:00.020Z", "error")], [log("2026-11-05T10:00:00.005Z", "WARNING"), log("2026-11-05T10:00:00.020Z", "error")], "2026-11-05T10:00:00.000Z");
    expect(steps.map((s) => [s.kind, s.offset])).toEqual([
      ["log", 5],
      ["span", 20],
      ["log", 20],
    ]);
    expect(steps[0].kind === "log" && steps[0].level).toBe("warn");
    expect(steps[1].kind === "span" && steps[1].failed).toBe(true);
    expect(offsetText(12.44)).toBe("+12.4 ms");
    expect(offsetText(-0.8)).toBe("−0.8 ms");
    expect(offsetText(12_345)).toBe("+12,345 ms");
  });
});

describe("rows and selection", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
  it("walks to neighbours, clamped", () => {
    expect(neighborId(rows, "b", 1)).toBe("c");
    expect(neighborId(rows, "c", 1)).toBe("c");
    expect(neighborId(rows, "a", -1)).toBe("a");
    expect(neighborId(rows, "z", 1)).toBeNull();
  });
  it("selects a range in either order", () => {
    expect(rangeKeys(["a", "b", "c", "d"], "c", "a")).toEqual(["a", "b", "c"]);
    expect(rangeKeys(["a", "b"], "z", "b")).toEqual(["b"]);
  });
});

describe("windows", () => {
  it("opens around a request and on its minute or hour", () => {
    expect(windowAround("2026-11-05T10:00:30Z", 5)).toEqual({ from: "2026-11-05T09:55:30Z", to: "2026-11-05T10:05:30Z" });
    expect(sameWindow("2026-11-05T10:12:30.5Z", "minute")).toEqual({ from: "2026-11-05T10:12:00Z", to: "2026-11-05T10:13:00Z" });
    expect(sameWindow("2026-11-05T10:12:30Z", "hour")).toEqual({ from: "2026-11-05T10:00:00Z", to: "2026-11-05T11:00:00Z" });
    expect(windowAround("nope", 5)).toBeNull();
  });
  it("reads a URL's query", () => {
    expect(queryPairs("/a?x=1&y=a%20b")).toEqual([
      ["x", "1"],
      ["y", "a b"],
    ]);
    expect(queryPairs("/a")).toEqual([]);
  });
});

describe("export", () => {
  const row = { timestamp: "2026-11-05T10:00:00Z", method: "GET", path: "/a", raw_path: '/a?q="x",y', status_code: 200, response_time_ms: 1.5, environment: "prod", consumer_id: "=cmd", consumer_name: "", trace_id: "t", id: "r1" } as RequestRow;
  it("writes CSV with quoting and formula guards", () => {
    const csv = toCsv([row]);
    const [head, line] = csv.split("\r\n");
    expect(head.startsWith("timestamp,method,path,raw_path,status_code")).toBe(true);
    expect(line).toContain('"/a?q=""x"",y"');
    expect(line).toContain("'=cmd");
    expect(csv.endsWith("\r\n")).toBe(true);
  });
  it("writes JSON of the exported columns", () => {
    expect(JSON.parse(toJson([row]))[0]).toMatchObject({ id: "r1", status_code: 200, app_id: null });
  });
  it("names the file", () => {
    expect(exportFileName("shop", "1h", Date.parse("2026-11-05T10:15:00.123Z"), "csv")).toBe("apilens-shop-requests-1h-20261105T101500Z.csv");
    expect(exportFileName("shop", "Nov 5, 10:00 – 11:00", 0, "json")).toBe("apilens-shop-requests-Nov-5-10-00-11-00-19700101T000000Z.json");
  });
});
