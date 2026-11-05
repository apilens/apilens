import { describe, expect, it } from "vitest";
import {
  checkSettings,
  checkSettingsDraft,
  endpointPageHref,
  endpointScopeText,
  formatBytes,
  formatShare,
  isExpected,
  latencyBucketLabel,
  loadSettingsError,
  parseEndpointQuery,
  parseEndpointRef,
  QUICK_EXPECTED,
  settingsBody,
  settingsDraft,
  settingsError,
  sizeBucketLabel,
  tabLoadFailed,
  thresholdText,
  toggleExpected,
  withThreshold,
} from "./endpoint-detail";
import { endpointHref } from "./traffic";

const EP = { method: "GET", path: "/orders/{id}" };

describe("parseEndpointQuery", () => {
  it("defaults to the Requests tab over the last 24 hours, everything else all", () => {
    expect(parseEndpointQuery({})).toEqual({ tab: "requests", range: "24h", env: "", status: "all", consumer: "", app: "" });
  });

  it("reads every part of the scope", () => {
    expect(parseEndpointQuery({ tab: "latency", range: "7d", env: " production ", status: "5xx", consumer: "acme", app: "shop" })).toEqual({
      tab: "latency",
      range: "7d",
      env: "production",
      status: "5xx",
      consumer: "acme",
      app: "shop",
    });
  });

  it("falls back on unknown or oversized values", () => {
    expect(parseEndpointQuery({ tab: "traces", range: "30d", status: "6xx", env: "e".repeat(65), consumer: "c".repeat(129) })).toEqual({
      tab: "requests",
      range: "24h",
      env: "",
      status: "all",
      consumer: "",
      app: "",
    });
  });
});

describe("parseEndpointRef", () => {
  it("decodes the route template and upper-cases the method", () => {
    expect(parseEndpointRef("get", "%2Forders%2F%7Bid%7D")).toEqual(EP);
  });

  it("takes a template the router already decoded", () => {
    expect(parseEndpointRef("POST", "/charge")).toEqual({ method: "POST", path: "/charge" });
  });

  it("refuses what the API would", () => {
    expect(parseEndpointRef("G3T", "%2Fx")).toBeNull();
    expect(parseEndpointRef("GET", "orders")).toBeNull();
    expect(parseEndpointRef("GET", "%E0%A4%A")).toBeNull();
    expect(parseEndpointRef("GET", `/${"a".repeat(1024)}`)).toBeNull();
  });
});

describe("endpointPageHref", () => {
  it("encodes method and path as one segment each and leaves defaults out", () => {
    expect(endpointPageHref("shop", EP, {})).toBe("/shop/endpoints/GET/%2Forders%2F%7Bid%7D");
    expect(endpointPageHref("shop", EP, { tab: "requests", range: "24h", status: "all" })).toBe("/shop/endpoints/GET/%2Forders%2F%7Bid%7D");
  });

  it("keeps the scope", () => {
    expect(endpointPageHref("shop", EP, { tab: "errors", range: "1h", env: "production", status: "4xx", consumer: "acme", app: "shop" })).toBe(
      "/shop/endpoints/GET/%2Forders%2F%7Bid%7D?tab=errors&range=1h&env=production&status=4xx&consumer=acme&app=shop",
    );
  });

  it("is where the Traffic table links", () => {
    expect(endpointPageHref("shop", EP, { range: "7d" })).toBe(endpointHref("shop", EP, { range: "7d" }));
  });
});

describe("endpointScopeText", () => {
  const q = parseEndpointQuery({});
  it("names the range, environment, status and consumer", () => {
    expect(endpointScopeText(q)).toBe("the last 24 hours");
    expect(endpointScopeText({ ...q, env: "production", status: "5xx", consumer: "c_1" }, "Acme")).toBe("the last 24 hours in production, 5xx responses, consumer Acme");
  });

  it("leaves the status out on the Errors tab, which does not filter by it", () => {
    expect(endpointScopeText({ ...q, tab: "errors", status: "5xx" })).toBe("the last 24 hours");
  });
});

describe("formatting", () => {
  it("formats bytes in binary units", () => {
    expect([0, -1, 512, 1024, 1536, 10 * 1024, 5 * 1024 * 1024 + 1].map(formatBytes)).toEqual(["0 B", "0 B", "512 B", "1 KB", "1.5 KB", "10 KB", "5 MB"]);
  });

  it("labels the response-time buckets the API documents", () => {
    expect(latencyBucketLabel({ from_ms: 0, to_ms: 1 })).toBe("0–1 ms");
    expect(latencyBucketLabel({ from_ms: 500, to_ms: 1000 })).toBe("500 ms–1 s");
    expect(latencyBucketLabel({ from_ms: 1000, to_ms: 2000 })).toBe("1–2 s");
    expect(latencyBucketLabel({ from_ms: 10000 })).toBe("≥10 s");
  });

  it("labels the body-size buckets the API documents", () => {
    expect(sizeBucketLabel({ from_bytes: 0, to_bytes: 1 })).toBe("0 B");
    expect(sizeBucketLabel({ from_bytes: 1, to_bytes: 256 })).toBe("1–256 B");
    expect(sizeBucketLabel({ from_bytes: 256, to_bytes: 1024 })).toBe("256 B–1 KB");
    expect(sizeBucketLabel({ from_bytes: 1024, to_bytes: 4096 })).toBe("1–4 KB");
    expect(sizeBucketLabel({ from_bytes: 4194304 })).toBe("≥4 MB");
  });

  it("formats a share", () => {
    expect([0, 0.0004, 0.125, 2].map(formatShare)).toEqual(["0%", "<0.1%", "12.5%", "100.0%"]);
  });

  it("names the tab that failed to load", () => {
    expect(tabLoadFailed("latency")).toBe("We couldn’t load response times just now.");
  });
});

describe("settings", () => {
  it("drafts saved settings for the form", () => {
    expect(settingsDraft({ expected_status_codes: [404, 409], latency_threshold_ms: 250, excluded: true })).toEqual({ codes: "404, 409", threshold: "250", excluded: true });
    expect(settingsDraft({ expected_status_codes: null, latency_threshold_ms: null, excluded: false })).toEqual({ codes: "", threshold: "", excluded: false });
  });

  it("checks the form: codes by comma or space, deduplicated and sorted; empty threshold is the app default", () => {
    expect(checkSettingsDraft({ codes: "409 404, 404", threshold: " ", excluded: false })).toEqual({
      ok: true,
      settings: { expected_status_codes: [404, 409], latency_threshold_ms: null, excluded: false },
    });
    expect(checkSettingsDraft({ codes: "", threshold: "750", excluded: true })).toEqual({ ok: true, settings: { expected_status_codes: [], latency_threshold_ms: 750, excluded: true } });
  });

  it("says what is wrong with each field", () => {
    const bad = checkSettingsDraft({ codes: "404, 4o4", threshold: "0", excluded: false });
    expect(bad).toEqual({
      ok: false,
      errors: {
        codes: "“4o4” is not a status code. Use codes from 100 to 599, like 404, 409.",
        threshold: "Enter whole milliseconds from 1 to 600,000, or leave it empty for the app default.",
      },
    });
    expect(checkSettingsDraft({ codes: "600", threshold: "1.5", excluded: false }).ok).toBe(false);
    const many = Array.from({ length: 33 }, (_, i) => 400 + i).join(",");
    expect(checkSettingsDraft({ codes: many, threshold: "", excluded: false })).toEqual({ ok: false, errors: { codes: "Mark at most 32 status codes as expected." } });
  });

  it("re-checks what reaches the Server Action", () => {
    expect(checkSettings({ expected_status_codes: [409, 404, 409], latency_threshold_ms: null, excluded: false })).toEqual({
      ok: true,
      settings: { expected_status_codes: [404, 409], latency_threshold_ms: null, excluded: false },
    });
    for (const bad of [null, "x", { expected_status_codes: [404], latency_threshold_ms: null }, { expected_status_codes: [99], latency_threshold_ms: null, excluded: false }, { expected_status_codes: [], latency_threshold_ms: 0, excluded: false }, { expected_status_codes: "404", latency_threshold_ms: null, excluded: false }]) {
      expect(checkSettings(bad).ok).toBe(false);
    }
  });

  it("answers a sentence for API errors", () => {
    expect(settingsError("forbidden")).toBe("Only project admins can change endpoint settings.");
    expect(settingsError("timeout")).toBe("We couldn’t reach APILens. Check your connection and try again.");
    expect(settingsError("whatever")).toBe("Something went wrong. Try again in a moment.");
  });
});

describe("row menu settings", () => {
  const saved = { expected_status_codes: [409], latency_threshold_ms: 250, excluded: false };

  it("keeps every other setting when it toggles 404", () => {
    expect(isExpected(saved, QUICK_EXPECTED)).toBe(false);
    const marked = toggleExpected(saved, QUICK_EXPECTED);
    expect(marked).toEqual({ expected_status_codes: [404, 409], latency_threshold_ms: 250, excluded: false });
    expect(toggleExpected(marked, QUICK_EXPECTED)).toEqual({ expected_status_codes: [409], latency_threshold_ms: 250, excluded: false });
    expect(toggleExpected({ expected_status_codes: null, latency_threshold_ms: null, excluded: true }, 404)).toEqual({ expected_status_codes: [404], latency_threshold_ms: null, excluded: true });
  });

  it("sends the saved settings back unchanged", () => {
    expect(settingsBody({ expected_status_codes: [409, 404], latency_threshold_ms: null, excluded: true })).toEqual({ expected_status_codes: [404, 409], latency_threshold_ms: null, excluded: true });
  });

  it("checks a typed threshold, empty meaning the app default", () => {
    expect(withThreshold(saved, " 900 ")).toEqual({ ok: true, settings: { expected_status_codes: [409], latency_threshold_ms: 900, excluded: false } });
    expect(withThreshold(saved, "")).toEqual({ ok: true, settings: { expected_status_codes: [409], latency_threshold_ms: null, excluded: false } });
    expect(withThreshold(saved, "0")).toEqual({ ok: false, error: "Enter whole milliseconds from 1 to 600,000, or leave it empty for the app default." });
    expect(withThreshold(saved, "1.5s").ok).toBe(false);
  });

  it("words the threshold and read failures", () => {
    expect(thresholdText(null)).toBe("App default");
    expect(thresholdText(1500)).toBe("1,500 ms");
    expect(loadSettingsError("forbidden")).toBe("We couldn’t load this endpoint’s settings just now. Try again in a moment.");
    expect(loadSettingsError("timeout")).toBe("We couldn’t reach APILens. Check your connection and try again.");
  });
});
