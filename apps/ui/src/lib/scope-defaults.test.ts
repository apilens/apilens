import { describe, expect, it, vi } from "vitest";
import type { QueryRange } from "./identity";
import {
  ENV_ALL,
  chooseRange,
  defaultEnv,
  envParam,
  envStorageKey,
  envToRestore,
  hrefWithEnv,
  rememberEnv,
  rememberedEnv,
  withScopeDefaults,
} from "./scope-defaults";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ALL: readonly QueryRange[] = ["1h", "6h", "24h", "7d"];

describe("chooseRange", () => {
  it("picks the smallest range that covers the project's first data", () => {
    expect(chooseRange(ago(5 * MIN), NOW, ALL, "24h")).toBe("1h");
    expect(chooseRange(ago(HOUR), NOW, ALL, "24h")).toBe("1h");
    expect(chooseRange(ago(HOUR + 1), NOW, ALL, "24h")).toBe("6h");
    expect(chooseRange(ago(6 * HOUR), NOW, ALL, "24h")).toBe("6h");
    expect(chooseRange(ago(7 * HOUR), NOW, ALL, "24h")).toBe("24h");
    expect(chooseRange(ago(2 * DAY), NOW, ALL, "24h")).toBe("7d");
    expect(chooseRange(ago(7 * DAY), NOW, ALL, "24h")).toBe("7d");
  });

  it("uses the largest range when the data is older than every range", () => {
    expect(chooseRange(ago(90 * DAY), NOW, ALL, "24h")).toBe("7d");
  });

  it("falls back to the page default without data or with a time that does not parse", () => {
    expect(chooseRange(null, NOW, ALL, "24h")).toBe("24h");
    expect(chooseRange(undefined, NOW, ALL, "24h")).toBe("24h");
    expect(chooseRange("", NOW, ALL, "24h")).toBe("24h");
    expect(chooseRange("not a time", NOW, ALL, "24h")).toBe("24h");
  });

  it("treats data stamped in the future (clock skew) as brand new", () => {
    expect(chooseRange(new Date(NOW + HOUR).toISOString(), NOW, ALL, "24h")).toBe("1h");
  });

  it("only picks a range the page offers", () => {
    expect(chooseRange(ago(5 * MIN), NOW, ["6h", "24h", "7d"], "24h")).toBe("6h");
    expect(chooseRange(ago(2 * DAY), NOW, ["1h", "24h"], "24h")).toBe("24h");
    expect(chooseRange(ago(5 * MIN), NOW, [], "24h")).toBe("24h");
  });
});

describe("defaultEnv", () => {
  it("is production when the project has it", () => {
    expect(defaultEnv(["staging", "production", "dev"])).toBe("production");
  });

  it("is the first environment without production", () => {
    expect(defaultEnv(["staging", "dev"])).toBe("staging");
  });

  it("is all environments when the project has none", () => {
    expect(defaultEnv([])).toBe("");
  });
});

describe("envParam", () => {
  it("writes all environments as env=all", () => {
    expect(envParam("")).toBe(ENV_ALL);
    expect(envParam("production")).toBe("production");
  });
});

describe("withScopeDefaults", () => {
  const opts = { environments: ["staging", "production"], ranges: ALL, fallbackRange: "24h" as QueryRange, now: NOW };

  it("fills a missing range from the first data and a missing env with production", async () => {
    const firstAt = vi.fn(async () => ago(20 * MIN));
    const got = await withScopeDefaults({ tab: "issues" }, { ...opts, firstAt });
    expect(got).toEqual({ params: { tab: "issues", range: "1h", env: "production" }, envExplicit: false });
    expect(firstAt).toHaveBeenCalledOnce();
  });

  it("keeps the URL's own range and env, without reading the ingest status", async () => {
    const firstAt = vi.fn(async () => ago(20 * MIN));
    const got = await withScopeDefaults({ range: "7d", env: "staging" }, { ...opts, firstAt });
    expect(got).toEqual({ params: { range: "7d", env: "staging" }, envExplicit: true });
    expect(firstAt).not.toHaveBeenCalled();
  });

  it("reads env=all as all environments, an explicit choice", async () => {
    const got = await withScopeDefaults({ range: "1h", env: "all" }, opts);
    expect(got).toEqual({ params: { range: "1h", env: "" }, envExplicit: true });
  });

  it("uses the page default when the ingest status cannot be read or has no data", async () => {
    expect((await withScopeDefaults({}, { ...opts, firstAt: async () => null })).params.range).toBe("24h");
    expect((await withScopeDefaults({}, { ...opts, firstAt: () => Promise.reject(new Error("down")) })).params.range).toBe("24h");
  });

  it("leaves env alone on a page without an environment filter", async () => {
    const got = await withScopeDefaults({}, { ranges: ALL, fallbackRange: "24h", now: NOW, firstAt: async () => ago(3 * DAY) });
    expect(got.params).toEqual({ range: "7d" });
  });
});

/** An in-memory Storage. */
function memoryStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

describe("remembered environment", () => {
  it("keeps the last choice per project", () => {
    const store = memoryStore();
    rememberEnv("shop", "staging", store);
    rememberEnv("billing", ENV_ALL, store);
    expect(rememberedEnv("shop", store)).toBe("staging");
    expect(rememberedEnv("billing", store)).toBe(ENV_ALL);
    expect(rememberedEnv("other", store)).toBeNull();
    expect(store.m.get(envStorageKey("shop"))).toBe("staging");
  });

  it("keeps nothing for an empty value", () => {
    const store = memoryStore();
    rememberEnv("shop", " ", store);
    expect(rememberedEnv("shop", store)).toBeNull();
  });

  it("survives storage that is missing or throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(() => rememberEnv("shop", "staging", throwing)).not.toThrow();
    expect(rememberedEnv("shop", throwing)).toBeNull();
    expect(() => rememberEnv("shop", "staging", null)).not.toThrow();
    expect(rememberedEnv("shop", null)).toBeNull();
  });
});

describe("envToRestore", () => {
  const envs = ["staging", "production"];

  it("restores the remembered environment over the default", () => {
    expect(envToRestore("staging", "production", envs)).toBe("staging");
    expect(envToRestore(ENV_ALL, "production", envs)).toBe(ENV_ALL);
  });

  it("does nothing when the page already shows it, or nothing was remembered", () => {
    expect(envToRestore("production", "production", envs)).toBeNull();
    expect(envToRestore(ENV_ALL, "", [])).toBeNull();
    expect(envToRestore(null, "production", envs)).toBeNull();
  });

  it("ignores an environment the project no longer has", () => {
    expect(envToRestore("qa", "production", envs)).toBeNull();
  });
});

describe("hrefWithEnv", () => {
  it("sets env, keeping the rest of the URL", () => {
    expect(hrefWithEnv("/shop/traffic", "staging")).toBe("/shop/traffic?env=staging");
    expect(hrefWithEnv("/shop/errors?tab=issues&env=production", ENV_ALL)).toBe("/shop/errors?tab=issues&env=all");
  });
});
