import { describe, expect, it } from "vitest";
import {
  alertError,
  badgeText,
  checkChannelDraft,
  checkRuleDraft,
  conditionText,
  eventDuration,
  formatMetric,
  formatSpan,
  incidentsHref,
  incidentsRange,
  isCron,
  isHookUrl,
  newChannelDraft,
  newRuleDraft,
  openCount,
  ruleDraftOf,
  ruleSummary,
  scheduleText,
  splitAddresses,
  testError,
} from "./alerts";
import type { AlertRule } from "./identity";

const RULE: AlertRule = {
  id: "r1",
  app_id: "app1",
  environment: "production",
  name: "Checkout errors",
  description: "",
  metric: "error_rate",
  condition: "gt",
  threshold: 0.025,
  window_s: 300,
  every_s: 60,
  cron: null,
  notify_after_s: 120,
  resolve_after_s: 600,
  filters: { endpoint: "POST /checkout" },
  channel_ids: ["c1"],
  enabled: true,
  created_by: null,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
};

describe("incidents", () => {
  it("counts open incidents for the badge", () => {
    expect(openCount([{ open: true }, { open: false }, { open: true }])).toBe(2);
    expect(openCount(null)).toBe(0);
    expect(badgeText(0)).toBe("");
    expect(badgeText(3)).toBe("3");
    expect(badgeText(250)).toBe("99+");
  });

  it("reads the range from the URL", () => {
    expect(incidentsRange("24h")).toBe("24h");
    expect(incidentsRange("1y")).toBe("7d");
    expect(incidentsRange(undefined)).toBe("7d");
    expect(incidentsHref("shop")).toBe("/shop/incidents");
    expect(incidentsHref("shop", "30d")).toBe("/shop/incidents?range=30d");
  });

  it("formats spans and durations", () => {
    expect(formatSpan(45)).toBe("45 s");
    expect(formatSpan(300)).toBe("5 min");
    expect(formatSpan(3600)).toBe("1 h");
    expect(formatSpan(12_000)).toBe("3 h 20 min");
    expect(formatSpan(2 * 86_400 + 4 * 3600)).toBe("2 d 4 h");
    const now = Date.parse("2026-11-05T10:12:00Z");
    expect(eventDuration({ started_at: "2026-11-05T10:00:00Z", ended_at: null }, now)).toBe("12 min");
    expect(eventDuration({ started_at: "2026-11-05T09:00:00Z", ended_at: "2026-11-05T09:08:00Z" }, now)).toBe("8 min");
  });
});

describe("metrics", () => {
  it("formats each metric in its unit", () => {
    expect(formatMetric("error_rate", 0.034)).toBe("3.4%");
    expect(formatMetric("error_rate", 0.0025)).toBe("0.25%");
    expect(formatMetric("p95", 412.4)).toBe("412 ms");
    expect(formatMetric("p95", 1520)).toBe("1.52 s");
    expect(formatMetric("apdex", 0.8)).toBe("0.80");
    expect(formatMetric("traffic", 12045)).toBe("12,045");
    expect(formatMetric("traffic", null)).toBe("–");
  });

  it("summarizes rules", () => {
    expect(conditionText("error_rate", "gt", 0.02)).toBe("> 2%");
    expect(conditionText("apdex", "lt", 0.85)).toBe("< 0.85");
    expect(ruleSummary(RULE)).toBe("Error rate > 2.5% over 5 min");
    expect(scheduleText(RULE)).toBe("every 1 min");
    expect(scheduleText({ every_s: null, cron: "*/5 * * * *" })).toBe("cron */5 * * * * (UTC)");
  });
});

describe("rule form", () => {
  it("round-trips a saved rule", () => {
    const d = ruleDraftOf(RULE);
    expect(d.threshold).toBe("2.5");
    expect(d.window_min).toBe("5");
    expect(d.notify_after_min).toBe("2");
    const checked = checkRuleDraft(d);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.body).toEqual({
      environment: "production",
      name: "Checkout errors",
      description: "",
      metric: "error_rate",
      condition: "gt",
      threshold: 0.025,
      window_s: 300,
      every_s: 60,
      notify_after_s: 120,
      resolve_after_s: 600,
      filters: { endpoint: "POST /checkout" },
      channel_ids: ["c1"],
      enabled: true,
    });
  });

  it("sends cron instead of every_s", () => {
    const checked = checkRuleDraft({ ...newRuleDraft("app1", "production"), name: "Nightly", schedule: "cron", cron: "0 3 * * *" });
    expect(checked.ok && checked.body.cron).toBe("0 3 * * *");
    expect(checked.ok && "every_s" in checked.body).toBe(false);
  });

  it("flags every invalid field", () => {
    const checked = checkRuleDraft({
      ...newRuleDraft(),
      name: " ",
      threshold: "150",
      window_min: "0",
      every_min: "1.5",
      notify_after_min: "-1",
      resolve_after_min: "2000",
      endpoint: "orders",
    });
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(Object.keys(checked.errors).sort()).toEqual(
      ["app_id", "endpoint", "environment", "every_min", "name", "notify_after_min", "resolve_after_min", "threshold", "window_min"].sort(),
    );
    expect(checked.errors.threshold).toBe("Enter a percentage from 0 to 100.");
  });

  it("bounds apdex to 0..1", () => {
    const checked = checkRuleDraft({ ...newRuleDraft("a", "production"), name: "Apdex", metric: "apdex", threshold: "2" });
    expect(!checked.ok && checked.errors.threshold).toBe("Apdex runs from 0 to 1.");
  });

  it("checks cron", () => {
    expect(isCron("*/5 * * * *")).toBe(true);
    expect(isCron("@hourly")).toBe(true);
    expect(isCron("@sometimes")).toBe(false);
    expect(isCron("* * *")).toBe(false);
  });
});

describe("channel form", () => {
  it("builds each config", () => {
    expect(checkChannelDraft({ ...newChannelDraft("email"), name: "On-call", addresses: "a@example.com, b@example.com" })).toEqual({
      ok: true,
      name: "On-call",
      config: { addresses: ["a@example.com", "b@example.com"] },
    });
    expect(checkChannelDraft({ ...newChannelDraft("slack"), name: "#ops", webhook_url: "https://hooks.slack.example/T1" })).toEqual({
      ok: true,
      name: "#ops",
      config: { webhook_url: "https://hooks.slack.example/T1" },
    });
    expect(checkChannelDraft({ ...newChannelDraft("webhook"), name: "PD", url: "https://hooks.example.com/x", secret: "0123456789abcdef" })).toEqual({
      ok: true,
      name: "PD",
      config: { url: "https://hooks.example.com/x", secret: "0123456789abcdef" },
    });
  });

  it("refuses bad configs", () => {
    const bad = checkChannelDraft({ ...newChannelDraft("webhook"), name: "", url: "http://hooks.example.com", secret: "short" });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(Object.keys(bad.errors).sort()).toEqual(["name", "secret", "url"]);
    const email = checkChannelDraft({ ...newChannelDraft("email"), name: "x", addresses: "nope" });
    expect(!email.ok && email.errors.addresses).toBe("Check nope: it is not an email address.");
  });

  it("keeps the saved config on an edit with blank config fields", () => {
    expect(checkChannelDraft({ ...newChannelDraft("slack"), name: "Renamed" }, true)).toEqual({ ok: true, name: "Renamed" });
    expect(checkChannelDraft({ ...newChannelDraft("slack"), name: "Renamed" }, false).ok).toBe(false);
  });

  it("checks webhook URLs and splits addresses", () => {
    expect(isHookUrl("https://example.com/hook")).toBe(true);
    expect(isHookUrl("https://user:pw@example.com/hook")).toBe(false);
    expect(isHookUrl("https://example.com/hook#x")).toBe(false);
    expect(isHookUrl("not a url")).toBe(false);
    expect(splitAddresses("a@example.com;b@example.com\nc@example.com")).toHaveLength(3);
  });
});

describe("copy", () => {
  it("maps error codes to sentences", () => {
    expect(alertError("forbidden")).toBe("Only project admins can change alerts. Ask a project admin.");
    expect(alertError("conflict", "channel")).toBe("This project already has a channel with that name.");
    expect(testError(502, "unavailable", "the channel did not accept the test notification: alerts: delivery failed: HTTP 404")).toBe(
      "The channel didn’t accept the test notification (HTTP 404). Check its settings.",
    );
    expect(testError(503, "unavailable")).toBe("We couldn’t reach APILens. Check your connection and try again.");
  });
});
