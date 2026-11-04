// Browser side of `POST /api/auth/2fa/exchange` (#320): finishes a sign-in that answered
// `2fa_required` with a code from the authenticator app or a backup code, and turns the Route
// Handler's answer into something the two-factor step can render. The pre-auth token never
// reaches the browser: it waits in its httpOnly cookie and the Route Handler reads it there.
// Client-safe: no server imports.

/** Wrong second factors identity tolerates per pending sign-in (`identity.PreAuthMaxAttempts`). */
export const MAX_TWO_FACTOR_ATTEMPTS = 5;

/** Why the two-factor step sends the browser back to sign-in (a `?reason=` notice there). */
export type StartOverReason = "2fa_locked" | "2fa_expired";

/** A same-origin path, or null (never an open redirect). */
function localPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  return value;
}

/**
 * `/sign-in` with the notice saying why the pending sign-in ended (locked after the fifth wrong
 * code, or expired), carrying `next` so the new sign-in lands where the first one was going.
 */
export function startOverPath(reason: StartOverReason, next?: string | null): string {
  const q = new URLSearchParams({ reason });
  const target = localPath(next);
  if (target && target !== "/") q.set("next", target);
  return `/sign-in?${q}`;
}

export type TwoFactorProof = { code: string } | { backup_code: string };

export type TwoFactorResult =
  /** Signed in: the session cookie is set, go to `next`. */
  | { kind: "signed_in"; next: string }
  /** Wrong code or backup code (or a backup code already spent). */
  | { kind: "invalid_code" }
  /** The fifth wrong one: identity dropped the pending sign-in, start over. */
  | { kind: "too_many_attempts" }
  /** The pending sign-in is gone (expired after 5 minutes, used, or never set in this browser). */
  | { kind: "expired" }
  /** No answer: the browser is offline, or identity is unreachable behind the Route Handler. */
  | { kind: "network" }
  /** Any other refusal, by stable `code`. */
  | { kind: "error"; code: string };

const ENDPOINT = "/api/auth/2fa/exchange";

/** Codes the Route Handler answers when identity itself could not be reached. */
const UNREACHABLE = new Set(["network_error", "timeout", "unavailable", "http_502", "http_503", "http_504"]);
/** Codes that mean there is no pending sign-in to finish. */
const EXPIRED = new Set(["invalid_token", "2fa_session_expired"]);

/** Keeps the digits of a typed or pasted authenticator code, at most six. */
export function cleanTotp(value: string): string {
  return value.replace(/\D/g, "").slice(0, 6);
}

/**
 * Formats a typed or pasted backup code as `xxxx-xxxx`: letters and digits only, lower case, the
 * dash inserted after the fourth. Identity ignores case, dashes and spaces anyway.
 */
export function cleanBackupCode(value: string): string {
  const raw = value.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
  return raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

/** A complete backup code (`xxxx-xxxx`). */
export function isBackupCode(value: string): boolean {
  return /^[a-z0-9]{4}-[a-z0-9]{4}$/.test(value);
}

/** Spends the proof on the pending sign-in. Never throws: transport failures come back as `{kind: "network"}`. */
export async function exchangeTwoFactor(proof: TwoFactorProof, fetcher: typeof fetch = fetch): Promise<TwoFactorResult> {
  let res: Response;
  try {
    res = await fetcher(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(proof),
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

  if (res.ok && body.ok === true) return { kind: "signed_in", next: localPath(body.next) ?? "/" };

  const code = typeof body.code === "string" && body.code !== "" ? body.code : `http_${res.status}`;
  if (code === "invalid_code" || code === "too_many_attempts") return { kind: code };
  if (EXPIRED.has(code)) return { kind: "expired" };
  if (UNREACHABLE.has(code)) return { kind: "network" };
  return { kind: "error", code };
}

/** Inline copy for a wrong code, counting what identity still allows. */
export function wrongTwoFactorMessage(backup: boolean, attemptsLeft: number): string {
  const wrong = backup ? "That backup code didn’t work." : "Wrong code.";
  if (attemptsLeft <= 0) return wrong;
  return `${wrong} ${attemptsLeft} ${attemptsLeft === 1 ? "attempt" : "attempts"} left.`;
}

/** Inline copy when the code could not be checked for lack of a connection. */
export const TWO_FACTOR_NETWORK_MESSAGE = "We couldn’t reach APILens. Check your connection and try again.";

/** Inline copy for any other refusal (sentence case, no exclamation marks). */
export function twoFactorErrorMessage(code: string, backup: boolean): string {
  switch (code) {
    case "validation_failed":
    case "invalid_request":
      return backup ? "Enter a backup code like abcd-1234." : "Enter the 6-digit code from your authenticator app.";
    default:
      return "Something went wrong checking your code. Try again.";
  }
}
