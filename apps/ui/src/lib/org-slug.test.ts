import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SLUG_CHECK_DELAY_MS, checkableSlug, cleanSuggestions, createSlugChecker, parseAvailability, slugify } from "./org-slug";

describe("slugify", () => {
  it.each([
    ["Example Co", "example-co"],
    ["  ACME, Inc.  ", "acme-inc"],
    ["--a--b--", "a-b"],
    ["ünïcode", "n-code"],
    ["a".repeat(40), "a".repeat(32)],
    [`${"a".repeat(31)} b`, "a".repeat(31)],
  ])("%s → %s", (name, slug) => {
    expect(slugify(name)).toBe(slug);
  });
});

describe("checkableSlug", () => {
  it.each(["ab", "example-co", "a1"])("accepts %s", (s) => expect(checkableSlug(s)).toBe(true));
  it.each(["", "a", "-ab", "Ab", "a_b", "a".repeat(64)])("refuses %s", (s) => expect(checkableSlug(s)).toBe(false));
});

describe("parseAvailability", () => {
  it("reads available and taken answers", () => {
    expect(parseAvailability({ ok: true, available: true, suggestions: [] })).toEqual({ kind: "available" });
    expect(parseAvailability({ ok: true, available: false, suggestions: ["acme-hq", "BAD", 3, "acme-2", "acme-3", "acme-4"] })).toEqual({
      kind: "taken",
      suggestions: ["acme-hq", "acme-2", "acme-3"],
    });
  });

  it.each([null, "x", { ok: false, code: "rate_limited" }, { ok: true }])("treats %s as unknown", (body) => {
    expect(parseAvailability(body)).toEqual({ kind: "unknown" });
  });

  it("cleanSuggestions ignores non-arrays", () => {
    expect(cleanSuggestions(undefined)).toEqual([]);
  });
});

describe("createSlugChecker", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

  it("waits for a pause in typing, then asks once for the latest slug", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json({ ok: true, available: true, suggestions: [] }));
    const onResult = vi.fn();
    const c = createSlugChecker({ fetch: fetcher, onResult });
    c.check("ex");
    c.check("exa");
    await vi.advanceTimersByTimeAsync(SLUG_CHECK_DELAY_MS - 1);
    expect(fetcher).not.toHaveBeenCalled();
    c.check("example");
    await vi.advanceTimersByTimeAsync(SLUG_CHECK_DELAY_MS);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe("/api/orgs/slug-available?slug=example");
    expect(onResult).toHaveBeenCalledWith("example", { kind: "available" });
  });

  it("aborts the request in flight on the next keystroke and drops its answer", async () => {
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((resolve, reject) => {
          const signal = init?.signal as AbortSignal;
          signals.push(signal);
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          setTimeout(() => resolve(json({ ok: true, available: false, suggestions: [] })), 1000);
        }),
    );
    const onResult = vi.fn();
    const c = createSlugChecker({ fetch: fetcher, onResult });
    c.check("acme");
    await vi.advanceTimersByTimeAsync(SLUG_CHECK_DELAY_MS);
    expect(signals).toHaveLength(1);
    c.check("acme-hq");
    expect(signals[0].aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(SLUG_CHECK_DELAY_MS + 1000);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith("acme-hq", { kind: "taken", suggestions: [] });
  });

  it("skips slugs the API would refuse and reports failures as unknown", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new TypeError("network");
    });
    const onResult = vi.fn();
    const c = createSlugChecker({ fetch: fetcher, onResult });
    c.check("a");
    await vi.advanceTimersByTimeAsync(SLUG_CHECK_DELAY_MS);
    expect(fetcher).not.toHaveBeenCalled();
    c.check("acme");
    await vi.advanceTimersByTimeAsync(SLUG_CHECK_DELAY_MS);
    expect(onResult).toHaveBeenCalledWith("acme", { kind: "unknown" });
  });

  it("cancel stops a pending check", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const c = createSlugChecker({ fetch: fetcher, onResult: vi.fn() });
    c.check("acme");
    c.cancel();
    await vi.advanceTimersByTimeAsync(SLUG_CHECK_DELAY_MS * 2);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
