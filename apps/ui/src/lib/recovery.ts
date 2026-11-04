// Account recovery when the two-factor device is lost (#321, backend #270). Server side:
//
// - `/auth/recovery` asks for an email address; `POST /api/auth/recovery/request` always answers
//   the same "if an account exists, we emailed instructions", whether or not one does.
// - The emails link to `/auth/recovery/status?token=` and `/auth/recovery/cancel?token=`. Both
//   pages load the request with {@link recoveryView} on the server; neither changes anything on
//   load (mail scanners open links), so confirming and cancelling are button presses that post
//   to `POST /api/auth/recovery/confirm` and `/cancel`.
// - Confirm turns 2FA off and answers a fresh session, which the Route Handler seals into the
//   cookie like any other sign-in. Identity creates that session without "remember me", so the
//   cookie is the 24-hour one.
import "server-only";
import {
  CLIENT_ERROR_CODES,
  type CallOptions,
  type IdentityClient,
  type RecoveryStatus,
  identity,
  isApiError,
} from "./identity";

/** Longest token identity accepts (`RecoveryTokenBody.token`). */
export const MAX_RECOVERY_TOKEN_LENGTH = 128;
/** Identity creates the recovered session without "remember me" (`sessions.Create(…, false, …)`). */
export const RECOVERY_REMEMBER = false;

/** Codes meaning "this link will never work": unknown, malformed, cancelled or already used. */
const DEAD_TOKEN = new Set<string>([
  "invalid_token",
  "invalid_request",
  CLIENT_ERROR_CODES.validation,
  CLIENT_ERROR_CODES.badRequest,
  CLIENT_ERROR_CODES.unauthorized,
]);

function first(input: unknown): string | undefined {
  if (Array.isArray(input)) return typeof input[0] === "string" ? input[0] : undefined;
  return typeof input === "string" ? input : undefined;
}

/** A usable token from the query, or undefined. */
export function recoveryToken(input: unknown): string | undefined {
  const value = first(input)?.trim();
  return value && value.length <= MAX_RECOVERY_TOKEN_LENGTH ? value : undefined;
}

/** "Nov 4, 2026, 14:03 UTC": rendered on the server, so it is the same in every browser. */
export function formatWhen(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return `${new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
  }).format(at)} UTC`;
}

export type RecoveryView =
  /** Waiting out the cooling-off period: count down `secondsLeft` to `readyAt`. */
  | { kind: "pending"; token: string; requestedAt: string; readyAt: string; secondsLeft: number }
  /** Past the cooling-off period: it can be confirmed (or still cancelled). */
  | { kind: "ready"; token: string; requestedAt: string; readyAt: string }
  /** Recovery already completed: 2FA is off; the link is spent. */
  | { kind: "confirmed"; requestedAt: string }
  /** Cancelled, or replaced by a newer request. */
  | { kind: "cancelled"; requestedAt: string }
  /** No token, or one identity does not know. */
  | { kind: "invalid" }
  /** Too many lookups from this address. */
  | { kind: "rate_limited"; retryAfter: number }
  /** Identity could not be reached or failed. */
  | { kind: "error" };

export interface ViewDeps {
  client?: IdentityClient;
  context?: CallOptions;
  /** Milliseconds since the epoch (tests). */
  now?: number;
}

/** Loads the request behind a recovery link and decides which state the page shows. */
export async function recoveryView(rawToken: unknown, deps: ViewDeps = {}): Promise<RecoveryView> {
  const token = recoveryToken(rawToken);
  if (!token) return { kind: "invalid" };

  let st: RecoveryStatus;
  try {
    st = await (deps.client ?? identity()).recoveryStatus(token, deps.context);
  } catch (err) {
    if (isApiError(err)) {
      if (DEAD_TOKEN.has(err.code)) return { kind: "invalid" };
      if (err.code === CLIENT_ERROR_CODES.rateLimited) return { kind: "rate_limited", retryAfter: err.retryAfter ?? 60 };
    } else {
      console.error("recovery status failed", err);
    }
    return { kind: "error" };
  }

  const requestedAt = formatWhen(st.requested_at);
  switch (st.status) {
    case "confirmed":
      return { kind: "confirmed", requestedAt };
    case "cancelled":
      return { kind: "cancelled", requestedAt };
    case "ready":
      return { kind: "ready", token, requestedAt, readyAt: formatWhen(st.ready_at) };
    case "pending": {
      const readyAtMs = Date.parse(st.ready_at);
      const secondsLeft = Number.isNaN(readyAtMs) ? 0 : Math.max(0, Math.ceil((readyAtMs - (deps.now ?? Date.now())) / 1000));
      // The clock passed `ready_at` between identity's answer and now: identity will accept it.
      if (secondsLeft === 0) return { kind: "ready", token, requestedAt, readyAt: formatWhen(st.ready_at) };
      return { kind: "pending", token, requestedAt, readyAt: formatWhen(st.ready_at), secondsLeft };
    }
    default:
      return { kind: "error" };
  }
}
