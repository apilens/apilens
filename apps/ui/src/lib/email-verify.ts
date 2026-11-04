// Browser side of `POST /api/auth/email/verify` (#315): signs in with the emailed 6-digit code
// and turns the Route Handler's answer into something `/verify` can render. Client-safe: no
// server imports.

/** Where a sign-in that answered `2fa_required` continues (the pre-auth token waits in its cookie). */
export const TWO_FACTOR_PATH = "/auth/2fa";
/** Where a first sign-up lands when the caller asked for nowhere in particular. */
export const NEW_USER_PATH = "/onboarding/about";
/** Wrong guesses identity tolerates per emailed code (`emailauth.MaxAttempts`). */
export const MAX_CODE_ATTEMPTS = 5;

export interface EmailVerifyInput {
  email: string;
  code: string;
  remember: boolean;
  /** Same-origin path to land on; the Route Handler re-checks it. */
  next?: string;
}

export type EmailVerifyResult =
  /** Signed in: the session cookie is set, go to `next`. */
  | { kind: "signed_in"; next: string }
  /** First factor accepted; finish at `next` (the 2FA step). */
  | { kind: "2fa_required"; next: string }
  /** Wrong code (or no outstanding code for the address). */
  | { kind: "invalid_code" }
  /** The code is past its lifetime: ask for a new one. */
  | { kind: "code_expired" }
  /** Too many wrong guesses: the code is locked until a new one is requested. */
  | { kind: "too_many_attempts" }
  /** Too many verify calls for this address: wait `retryAfter` seconds. */
  | { kind: "rate_limited"; retryAfter: number }
  /** No answer: the browser is offline, or identity is unreachable behind the Route Handler. */
  | { kind: "network" }
  /** Any other refusal, by stable `code`. */
  | { kind: "error"; code: string };

/** Seconds to wait when a `rate_limited` answer carries no `Retry-After`. */
export const DEFAULT_VERIFY_RETRY_AFTER = 30;

const ENDPOINT = "/api/auth/email/verify";

/** Codes the Route Handler answers when identity itself could not be reached. */
const UNREACHABLE = new Set(["network_error", "timeout", "unavailable", "http_502", "http_503", "http_504"]);

function seconds(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.ceil(n) : null;
}

/** A same-origin path, or null (never an open redirect). */
function localPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  return value;
}

/** The 2FA step, carrying where to land once it is done. */
export function twoFactorPath(next: string | null): string {
  return next && next !== "/" ? `${TWO_FACTOR_PATH}?${new URLSearchParams({ next })}` : TWO_FACTOR_PATH;
}

/** Checks the code. Never throws: transport failures come back as `{kind: "network"}`. */
export async function verifyEmailCode(input: EmailVerifyInput, fetcher: typeof fetch = fetch): Promise<EmailVerifyResult> {
  let res: Response;
  try {
    res = await fetcher(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        email: input.email,
        code: input.code,
        remember: input.remember,
        ...(input.next ? { next: input.next } : {}),
      }),
    });
  } catch {
    return { kind: "network" };
  }

  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = await res.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    // A proxy error page or empty body: fall through on the status alone.
  }

  if (res.ok && body.ok === true) return { kind: "signed_in", next: localPath(body.next) ?? input.next ?? "/" };

  const code = typeof body.code === "string" && body.code !== "" ? body.code : `http_${res.status}`;
  switch (code) {
    case "2fa_required":
      return { kind: "2fa_required", next: twoFactorPath(localPath(body.next) ?? input.next ?? null) };
    case "invalid_code":
    case "code_expired":
    case "too_many_attempts":
      // `too_many_attempts` is a 429 too: match the code before the status.
      return { kind: code };
  }
  if (code === "rate_limited" || res.status === 429) {
    return {
      kind: "rate_limited",
      retryAfter: seconds(body.retry_after) ?? seconds(res.headers.get("retry-after")) ?? DEFAULT_VERIFY_RETRY_AFTER,
    };
  }
  if (UNREACHABLE.has(code)) return { kind: "network" };
  return { kind: "error", code };
}

/** Inline copy for a wrong code, counting what identity still allows. */
export function wrongCodeMessage(attemptsLeft: number): string {
  if (attemptsLeft <= 0) return "Wrong code.";
  return `Wrong code. ${attemptsLeft} ${attemptsLeft === 1 ? "attempt" : "attempts"} left.`;
}

/** Inline copy for an expired code. */
export const EXPIRED_MESSAGE = "This code has expired. Send a new one to continue.";
/** Inline copy for a locked code. */
export const LOCKED_MESSAGE = "Too many wrong codes. Send a new one to continue.";
/** Inline copy when the code could not be checked for lack of a connection. */
export const VERIFY_NETWORK_MESSAGE = "We couldn’t reach APILens. Check your connection and try again.";

/** Inline copy for a verify rate limit, counting down. */
export function verifyRateLimitMessage(secondsLeft: number): string {
  const n = Math.max(1, Math.ceil(secondsLeft));
  return `Too many attempts. Try again in ${n} ${n === 1 ? "second" : "seconds"}.`;
}

/** Inline copy for any other refusal (sentence case, no exclamation marks). */
export function verifyErrorMessage(code: string): string {
  switch (code) {
    case "validation_failed":
    case "invalid_request":
      return "Enter the 6-digit code from the email.";
    default:
      return "Something went wrong checking your code. Try again.";
  }
}

/** `m:ss` for the resend countdown. */
export function countdown(secondsLeft: number): string {
  const s = Math.max(0, Math.ceil(secondsLeft));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
