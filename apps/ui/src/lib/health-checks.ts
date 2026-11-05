// Project settings → Health checks (#608): active HTTP checks of an app environment. Every minute
// APILens sends GET to the URL (5 s timeout, one retry); a check whose retry fails too is down and
// opens an event carrying the failed request (status, latency, error, the start of the response
// body masked by the privacy policy). The input checks, labels and sentences the panel shows.
// Pure; safe in Client and Server Components and in Server Actions alike.
import type { CreateHealthCheckRequest, HealthCheckProbe } from "./identity";

/** The section of project settings that lists the health checks. */
export const HEALTH_CHECKS_SECTION = "health-checks";

/** Failures shown per check, newest first (`limit` of `GET .../health-checks/{id}/events`). */
export const EVENTS_SHOWN = 5;

/** How often and how patiently a check is probed, as the panel explains it. */
export const PROBE_POLICY = "Every minute, APILens sends GET to the URL with a 5 second timeout and retries once before the check counts as failing.";

/** `/<project>/settings/health-checks`. */
export function healthChecksPath(project: string): string {
  return `/${project}/settings/${HEALTH_CHECKS_SECTION}`;
}

const MAX_URL = 2048;
const MAX_ENV = 64;

export type HealthCheckField = "app_id" | "environment" | "url" | "expected_status";

export type CheckedHealthCheck =
  | { ok: true; body: CreateHealthCheckRequest }
  | { ok: false; field: HealthCheckField; error: string };

/**
 * Checks the create form (a Server Action re-checks it: it is a public endpoint). The server has
 * the last word on the URL: it also refuses private and loopback addresses unless the install
 * allows them, which only it knows.
 */
export function checkHealthCheckInput(input: unknown): CheckedHealthCheck {
  const v = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const appId = typeof v.app_id === "string" ? v.app_id.trim() : "";
  if (!appId) return { ok: false, field: "app_id", error: "Choose the app the URL belongs to." };
  const environment = typeof v.environment === "string" ? v.environment.trim() : "";
  if (!environment || environment.length > MAX_ENV) return { ok: false, field: "environment", error: "Name the environment, at most 64 characters." };
  const raw = typeof v.url === "string" ? v.url.trim() : "";
  if (!raw) return { ok: false, field: "url", error: "Enter the URL to check." };
  if (raw.length > MAX_URL) return { ok: false, field: "url", error: "Use a URL of at most 2048 characters." };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, field: "url", error: "Enter a full URL, starting with https:// or http://." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, field: "url", error: "Use an https:// or http:// URL." };
  if (url.username || url.password) return { ok: false, field: "url", error: "Leave credentials out of the URL." };
  if (raw.includes("#")) return { ok: false, field: "url", error: "Leave the #fragment out of the URL: it is never sent." };
  let expected = 200;
  if (v.expected_status !== undefined && v.expected_status !== "") {
    const n = typeof v.expected_status === "number" ? v.expected_status : Number(v.expected_status);
    if (!Number.isInteger(n) || n < 100 || n > 599) return { ok: false, field: "expected_status", error: "Use an HTTP status from 100 to 599." };
    expected = n;
  }
  return { ok: true, body: { app_id: appId, environment, url: raw, expected_status: expected } };
}

/** What a probe got, for people: `HTTP 503, expected 200`, the failure class, or `Passing`. */
export function probeOutcome(p: HealthCheckProbe): string {
  if (p.ok) return `Passing (HTTP ${p.status_code})`;
  if (p.status_code) return `HTTP ${p.status_code}, expected ${p.expected_status}`;
  return p.error ? capitalize(p.error) : "No response";
}

/** `41 ms`, `1.2 s`. */
export function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "–";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")} s`;
}

/** `2 (retried once)`, `1 (not retried)`. */
export function attemptsLabel(n: number): string {
  return n >= 2 ? `${n} (retried once)` : "1 (not retried)";
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** The sentence a failed create or delete shows. `detail` is the API's problem detail for a 422. */
export function healthCheckError(code: string, detail?: string): string {
  switch (code) {
    case "validation_failed":
    case "invalid_request":
    case "bad_request":
      return detail ? `Not accepted: ${detail.replace(/\.$/, "")}.` : "That check wasn’t accepted. Check the URL and try again.";
    case "forbidden":
      return "Only project admins can change health checks. Ask an admin.";
    case "not_found":
      return "This health check or project no longer exists. Reload the page.";
    case "authz_unavailable":
    case "network_error":
    case "timeout":
    case "unavailable":
      return "We couldn’t reach APILens. Check your connection and try again.";
    default:
      return "Something went wrong. Try again in a moment.";
  }
}
