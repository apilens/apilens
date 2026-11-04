// Browser side of account recovery (#321): the three Route Handlers under
// `/api/auth/recovery/*` and the copy the pages show. Client-safe: no server imports.

/** The "lost your device?" form. */
export const RECOVERY_PATH = "/auth/recovery";
/** Where the "recovery ready" email links (`?token=`). */
export const RECOVERY_STATUS_PATH = "/auth/recovery/status";
/** Where the "recovery requested" alert links (`?token=`). */
export const RECOVERY_CANCEL_PATH = "/auth/recovery/cancel";
/** Where a confirmed recovery lands: the gate sends it on to the last project or onboarding. */
export const RECOVERED_PATH = "/";

/** Seconds to wait when a 429 carries no `Retry-After`. */
export const DEFAULT_RETRY_AFTER = 60;

export type RecoveryAction = "request" | "confirm" | "cancel";

export type RecoveryResult =
  /** Done: for confirm the session cookie is set, go to `next`. */
  | { kind: "ok"; next: string }
  /** Confirm before `ready_at`: wait `retryAfter` seconds. */
  | { kind: "not_ready"; retryAfter: number | null }
  /** The link is unknown, cancelled or already used. */
  | { kind: "invalid_token" }
  /** Too many attempts: wait `retryAfter` seconds. */
  | { kind: "rate_limited"; retryAfter: number }
  /** No answer: the browser is offline, or identity is unreachable behind the Route Handler. */
  | { kind: "network" }
  /** Any other refusal, by stable `code`. */
  | { kind: "error"; code: string };

/** Codes the Route Handler answers when identity itself could not be reached. */
const UNREACHABLE = new Set(["network_error", "timeout", "unavailable", "http_502", "http_503", "http_504"]);

function seconds(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.ceil(n) : null;
}

const sameOrigin = (v: unknown): v is string => typeof v === "string" && v.startsWith("/") && !v.startsWith("//");

/** Posts to `/api/auth/recovery/<action>`. Never throws. */
export async function postRecovery(
  action: RecoveryAction,
  body: { email: string } | { token: string },
  fetcher: typeof fetch = fetch,
): Promise<RecoveryResult> {
  let res: Response;
  try {
    res = await fetcher(`/api/auth/recovery/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: "network" };
  }

  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    // A proxy error page or empty body: fall through on the status alone.
  }

  const retryAfter = seconds(data.retry_after) ?? seconds(res.headers.get("retry-after"));
  if (res.ok && data.ok === true) return { kind: "ok", next: sameOrigin(data.next) ? data.next : RECOVERED_PATH };
  if (data.code === "recovery_not_ready") return { kind: "not_ready", retryAfter };
  if (data.code === "invalid_token") return { kind: "invalid_token" };
  if (res.status === 429 || data.code === "rate_limited") return { kind: "rate_limited", retryAfter: retryAfter ?? DEFAULT_RETRY_AFTER };
  const code = typeof data.code === "string" && data.code !== "" ? data.code : `http_${res.status}`;
  if (UNREACHABLE.has(code)) return { kind: "network" };
  return { kind: "error", code };
}

/** "23 h 59 m", "4 m 05 s", "12 s": time left until recovery can be confirmed. */
export function countdown(secondsLeft: number): string {
  const s = Math.max(0, Math.ceil(secondsLeft));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h} h ${String(m).padStart(2, "0")} m`;
  if (m > 0) return `${m} m ${String(sec).padStart(2, "0")} s`;
  return `${sec} s`;
}

/** Inline copy for a wait: "Try again in 30 seconds." / "… in 2 minutes." */
export function waitMessage(secondsLeft: number): string {
  const n = Math.max(1, Math.ceil(secondsLeft));
  if (n < 120) return `Too many attempts. Try again in ${n} ${n === 1 ? "second" : "seconds"}.`;
  const min = Math.ceil(n / 60);
  return `Too many attempts. Try again in ${min} minutes.`;
}

export const NETWORK_MESSAGE = "We couldn’t reach APILens. Check your connection and try again.";

/** Inline copy for any other refusal. */
export function recoveryErrorMessage(code: string): string {
  switch (code) {
    case "validation_failed":
    case "invalid_request":
      return "Enter a work email like you@company.com.";
    default:
      return "Something went wrong. Try again in a moment.";
  }
}
