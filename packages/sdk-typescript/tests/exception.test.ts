import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyStackTraceLimit,
  DEFAULT_STACK_TRACE_LIMIT,
  exceptionContent,
  MAX_CAUSE_DEPTH,
  MAX_EXCEPTION_PAYLOAD_CHARS,
  truncateHeadTail,
} from "../src/exception.js";
import { CaptureCore } from "../src/capture.js";
import { ApiLensClient } from "../src/client.js";
import { errorLogContent } from "../src/spans.js";

/** The full exception payload (M5 D3, D4) for the TypeScript SDK. */

describe("exceptionContent", () => {
  it("renders a cause chain of 3 after the raised error's stack", () => {
    const root = new RangeError("disk full");
    const middle = new Error("write failed", { cause: root });
    const top = new TypeError("save order", { cause: middle });

    const out = exceptionContent(top);

    expect(out.message).toBe("TypeError: save order");
    const lines = out.payload.split("\n");
    expect(lines[0]).toBe("TypeError: save order");
    expect(lines[1]).toMatch(/^\s+at /);
    const middleAt = lines.indexOf("Caused by: Error: write failed");
    const rootAt = lines.indexOf("Caused by: RangeError: disk full");
    expect(middleAt).toBeGreaterThan(1);
    expect(rootAt).toBeGreaterThan(middleAt);
    expect(lines[rootAt + 1]).toMatch(/^\s+at .*exception\.test\.ts/);
    expect(out.attributes).toEqual({
      "exception.type": "TypeError",
      "exception.message": "save order",
      "exception.chain_depth": "2",
    });
  });

  it("renders every AggregateError member, and their causes", () => {
    const agg = new AggregateError(
      [new TypeError("first"), new Error("second", { cause: new Error("deep") }), "plain string"],
      "all failed",
    );

    const out = exceptionContent(agg);

    expect(out.message).toBe("AggregateError: all failed");
    expect(out.payload.startsWith("AggregateError: all failed\n")).toBe(true);
    expect(out.payload).toContain("\nAggregated error 1 of 3: TypeError: first\n");
    expect(out.payload).toContain("\nAggregated error 2 of 3: Error: second\n");
    expect(out.payload).toContain("\nCaused by: Error: deep\n");
    expect(out.payload).toContain("\nAggregated error 3 of 3: plain string");
    expect(out.attributes["exception.type"]).toBe("AggregateError");
  });

  it("does not hang on a cycle in the cause chain", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;

    const out = exceptionContent(a);

    expect(out.payload).toContain("Caused by: Error: b");
    expect(out.payload).toContain("Caused by: [Circular: Error: a]");
    expect(out.attributes["exception.chain_depth"]).toBe("1");
  });

  it("does not hang on a self-cause or a cyclic AggregateError", () => {
    const self = new Error("self");
    (self as { cause?: unknown }).cause = self;
    expect(exceptionContent(self).payload).toContain("Caused by: [Circular: Error: self]");

    const members: unknown[] = [];
    const agg = new AggregateError(members, "loop");
    (agg as { errors: unknown[] }).errors.push(agg);
    expect(exceptionContent(agg).payload).toContain("Aggregated error 1 of 1: [Circular: AggregateError: loop]");
  });

  it(`follows at most ${MAX_CAUSE_DEPTH} causes`, () => {
    let error = new Error("level 0");
    for (let i = 1; i <= 15; i += 1) {
      error = new Error(`level ${i}`, { cause: error });
    }

    const out = exceptionContent(error);

    expect(out.payload).toContain("Caused by: Error: level 5\n");
    expect(out.payload).not.toContain("level 4\n");
    expect(out.payload).toContain(`Caused by: [omitted: depth limit ${MAX_CAUSE_DEPTH} reached]`);
    expect(out.attributes["exception.chain_depth"]).toBe(String(MAX_CAUSE_DEPTH));
  });

  it("renders a non-Error cause with String() and a JSON preview", () => {
    const out = exceptionContent(new Error("outer", { cause: { code: "E42", retry: false } }));
    expect(out.payload).toContain('Caused by: [object Object]\n{"code":"E42","retry":false}');
  });

  it("uses the current name and message when they changed after construction", () => {
    const error = new Error("original");
    error.name = "PaymentError";
    error.message = "card declined";

    const out = exceptionContent(error);

    expect(out.payload.split("\n")[0]).toBe("PaymentError: card declined");
    expect(out.payload).not.toContain("original");
    expect(out.payload.split("\n")[1]).toMatch(/^\s+at /);
  });

  it("renders a non-Error throw as String(value) plus a JSON preview", () => {
    const thrown = { status: 503, reason: "upstream down" };
    const out = exceptionContent(thrown);
    expect(out.message).toBe("Error: [object Object]");
    expect(out.payload).toBe('[object Object]\n{"status":503,"reason":"upstream down"}');
    expect(out.attributes["exception.type"]).toBe("Object");

    expect(exceptionContent("boom").payload).toBe("boom");
    expect(exceptionContent("boom").attributes["exception.type"]).toBe("string");
    expect(exceptionContent(42).payload).toBe("42");
  });

  it("previews a cyclic or BigInt-holding object without throwing", () => {
    const thrown: Record<string, unknown> = { id: 10n };
    thrown.self = thrown;
    expect(exceptionContent(thrown).payload).toBe('[object Object]\n{"id":"10","self":"[Circular]"}');
  });

  it("caps the payload at 64 KiB keeping the head and the root cause at the tail", () => {
    const root = new Error("ROOT CAUSE");
    const top = new Error(`TOP ${"x".repeat(200_000)}`, { cause: root });

    const out = exceptionContent(top);

    expect(out.payload.length).toBeLessThanOrEqual(MAX_EXCEPTION_PAYLOAD_CHARS);
    expect(out.payload.startsWith("Error: TOP x")).toBe(true);
    expect(out.payload).toMatch(/\n…\[\d+ chars truncated\]…\n/);
    expect(out.payload).toContain("Caused by: Error: ROOT CAUSE");
    expect(out.attributes["exception.message"].length).toBeLessThanOrEqual(512);
  });
});

describe("truncateHeadTail", () => {
  it("keeps short text as is", () => {
    expect(truncateHeadTail("abc", 10)).toBe("abc");
  });

  it("keeps head and tail with the dropped count", () => {
    const text = "a".repeat(30) + "z".repeat(30);
    const out = truncateHeadTail(text, 40);
    expect(out.length).toBeLessThanOrEqual(40);
    const match = out.match(/^(a+)\n…\[(\d+) chars truncated\]…\n(z+)$/);
    expect(match).not.toBeNull();
    expect(match![1].length + match![3].length + Number(match![2])).toBe(60);
  });

  it("never splits a surrogate pair", () => {
    const out = truncateHeadTail("😀".repeat(100), 60);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });
});

describe("Error.stackTraceLimit", () => {
  const original = Error.stackTraceLimit;
  beforeEach(() => {
    Error.stackTraceLimit = 10;
  });
  afterEach(() => {
    Error.stackTraceLimit = original;
  });

  it(`is raised to ${DEFAULT_STACK_TRACE_LIMIT} by default`, () => {
    applyStackTraceLimit(undefined);
    expect(Error.stackTraceLimit).toBe(50);
  });

  it("is left alone when the app already set it higher", () => {
    Error.stackTraceLimit = 200;
    applyStackTraceLimit(undefined);
    expect(Error.stackTraceLimit).toBe(200);
    Error.stackTraceLimit = Infinity;
    applyStackTraceLimit(80);
    expect(Error.stackTraceLimit).toBe(Infinity);
  });

  it("follows the stackTraceLimit option", () => {
    applyStackTraceLimit(120);
    expect(Error.stackTraceLimit).toBe(120);
  });

  it("is applied when the middleware initialises", async () => {
    new CaptureCore({ apiKey: "k", appId: "a", fetchImpl: async () => new Response(null, { status: 202 }) });
    expect(Error.stackTraceLimit).toBe(50);
    await ApiLensClient.shutdown();
    new CaptureCore({
      apiKey: "k",
      appId: "a",
      stackTraceLimit: 75,
      fetchImpl: async () => new Response(null, { status: 202 }),
    });
    expect(Error.stackTraceLimit).toBe(75);
    await ApiLensClient.shutdown();
  });

  it("gives the exception log more than V8's default 10 frames", () => {
    applyStackTraceLimit(undefined);
    const recurse = (n: number): never => (n === 0 ? (() => { throw new Error("deep"); })() : recurse(n - 1));
    let caught: unknown;
    try {
      recurse(30);
    } catch (error) {
      caught = error;
    }
    const frames = exceptionContent(caught).payload.split("\n").filter((l) => /^\s+at /.test(l));
    expect(frames.length).toBeGreaterThan(30);
  });
});

describe("errorLogContent", () => {
  it("carries the full exception and its attributes for a thrown error", () => {
    const out = errorLogContent(new Error("outer", { cause: new Error("inner") }), 500, "GET", "/x");
    expect(out.loggerName).toBe("apilens.exception");
    expect(out.payload).toContain("Caused by: Error: inner");
    expect(out.attributes?.["exception.chain_depth"]).toBe("1");
  });

  it("is an HTTP log without attributes when nothing was thrown", () => {
    const out = errorLogContent(undefined, 503, "GET", "/x");
    expect(out).toEqual({ message: "HTTP 503 on GET /x", payload: "", loggerName: "apilens.http" });
  });
});
