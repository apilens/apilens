import { describe, expect, it } from "vitest";
import { NO_FILTERS } from "./explore-filters";
import { activeView, canEditView, canSaveFilters, checkViewName, filtersOfView, isPending, sortViews, upsertView, viewError, viewFilter } from "./explore-views";

const ME = "u-me";
const OTHER = "u-other";

const view = (id: string, name: string, filter: Record<string, unknown>, extra: { shared?: boolean; created_by?: string | null } = {}) => ({
  id,
  name,
  filter,
  shared: extra.shared ?? false,
  created_by: extra.created_by === undefined ? ME : extra.created_by,
});

describe("viewFilter and filtersOfView", () => {
  it("saves only the filters that are on, under their URL names, and reads them back", () => {
    const f = { ...NO_FILTERS, env: "production", status: "5xx", latency_min: 500 };
    expect(viewFilter(f)).toEqual({ env: "production", status: "5xx", latency_min: "500" });
    expect(filtersOfView({ filter: viewFilter(f) })).toEqual(f);
  });

  it("takes numbers and booleans as written by another client, and drops what the log refuses", () => {
    expect(filtersOfView({ filter: { latency_max: 900, sampled: false, method: "g3t", status: "abc", nested: { a: 1 } } })).toEqual({ ...NO_FILTERS, latency_max: 900, sampled: "false" });
    expect(filtersOfView({ filter: null as unknown as Record<string, unknown> })).toEqual(NO_FILTERS);
  });
});

describe("activeView", () => {
  const views = [view("a", "Errors", { status: "5xx" }), view("b", "Prod errors", { env: "production", status: "5xx" })];

  it("is the view whose filters are the page's", () => {
    expect(activeView(views, { ...NO_FILTERS, status: "5xx", env: "production" })?.id).toBe("b");
    expect(activeView(views, { ...NO_FILTERS, status: "5xx" })?.id).toBe("a");
    // A view saved by another client is read as a URL would be.
    expect(activeView([view("c", "Loud", { status: "5XX" })], { ...NO_FILTERS, status: "5xx" })?.id).toBe("c");
  });

  it("is null when no view holds the filters", () => {
    expect(activeView(views, { ...NO_FILTERS, status: "4xx" })).toBeNull();
    expect(activeView(views, NO_FILTERS)).toBeNull();
  });
});

describe("canSaveFilters", () => {
  it("needs a filter on that no view holds", () => {
    const views = [view("a", "Errors", { status: "5xx" })];
    expect(canSaveFilters(views, NO_FILTERS)).toBe(false);
    expect(canSaveFilters(views, { ...NO_FILTERS, status: "5xx" })).toBe(false);
    expect(canSaveFilters(views, { ...NO_FILTERS, status: "4xx" })).toBe(true);
  });
});

describe("checkViewName", () => {
  const views = [view("a", "Errors", {}), view("b", "Shared", {}, { created_by: OTHER, shared: true })];

  it("trims and bounds the name", () => {
    expect(checkViewName("  Slow checkout ", views, ME)).toEqual({ ok: true, name: "Slow checkout" });
    expect(checkViewName("   ", views, ME)).toMatchObject({ ok: false });
    expect(checkViewName("x".repeat(129), views, ME)).toMatchObject({ ok: false, error: "Use at most 128 characters." });
    expect(checkViewName("é".repeat(128), views, ME)).toMatchObject({ ok: true });
    expect(checkViewName(42, views, ME)).toMatchObject({ ok: false });
  });

  it("refuses a name the creator already uses, except on the view itself", () => {
    expect(checkViewName("Errors", views, ME)).toEqual({ ok: false, error: "You already have a view with this name." });
    expect(checkViewName("Errors", views, ME, "a")).toEqual({ ok: true, name: "Errors" });
    // Another user's view may share the name.
    expect(checkViewName("Shared", views, ME)).toEqual({ ok: true, name: "Shared" });
  });
});

describe("canEditView", () => {
  it("lets the creator edit, and admins edit shared views", () => {
    expect(canEditView({ created_by: ME, shared: false }, ME, false)).toBe(true);
    expect(canEditView({ created_by: OTHER, shared: true }, ME, false)).toBe(false);
    expect(canEditView({ created_by: OTHER, shared: true }, ME, true)).toBe(true);
    expect(canEditView({ created_by: null, shared: true }, ME, true)).toBe(true);
    expect(canEditView({ created_by: OTHER, shared: false }, ME, true)).toBe(false);
  });
});

describe("sortViews and upsertView", () => {
  it("keeps the list by name, replacing an optimistic view with the saved one", () => {
    const list = sortViews([view("b", "beta", {}), view("a", "Alpha", {})]);
    expect(list.map((v) => v.name)).toEqual(["Alpha", "beta"]);
    const pending = view("pending:1", "Gamma", {});
    expect(isPending(pending)).toBe(true);
    const withPending = upsertView(list, pending);
    expect(withPending.map((v) => v.id)).toEqual(["a", "b", "pending:1"]);
    const saved = upsertView(withPending, view("c", "Gamma", {}), "pending:1");
    expect(saved.map((v) => v.id)).toEqual(["a", "b", "c"]);
    expect(upsertView(saved, view("a", "Zed", {})).map((v) => v.id)).toEqual(["b", "c", "a"]);
  });
});

describe("viewError", () => {
  it("answers a sentence per code", () => {
    expect(viewError("conflict")).toBe("You already have a view with this name.");
    expect(viewError("forbidden")).toBe("Only the view’s creator or a project admin can change it.");
    expect(viewError("unavailable")).toBe("We couldn’t reach APILens. Check your connection and try again.");
    expect(viewError("weird")).toBe("Something went wrong. Try again in a moment.");
  });
});
