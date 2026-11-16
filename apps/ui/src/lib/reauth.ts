// Re-authentication (#803, D12): a sensitive action whose Server Action answers
// `{ok: false, code: "reauth_required"}` opens the ReauthDialog instead of showing an error; once
// the user has confirmed who they are, the action runs again, exactly once.
//
// Ceremony: `POST /api/auth/reauth/options` (methods, passkey options, emails a code on request)
// → passkey assertion or a code → `POST /api/auth/reauth/verify` (writes the session cookie with
// the new access token) → retry.
//
// Client-safe: no server imports. Browser APIs are passed in (`env`) so tests can fake them.
import { type PasskeyEnv, assertionToJSON, passkeysSupported, requestOptionsFromJSON } from "./auth/passkeys";

/** `code` of an action refused because the sign-in is older than the sensitive-action window. */
export const REAUTH_REQUIRED = "reauth_required";
/** `code` {@link withReauthRetry} answers when the user closed the dialog: nothing was changed. */
export const REAUTH_CANCELLED = "reauth_cancelled";

export type ReauthMethod = "passkey" | "totp" | "email" | "sso";

/** The shape every Server Action answers; only `ok` and `code` matter here. */
export type ActionResult = { ok: boolean; code?: string };

export type Cancelled = { ok: false; error: string; code: typeof REAUTH_CANCELLED };

export const CANCELLED: Cancelled = { ok: false, error: "Cancelled. Nothing was changed.", code: REAUTH_CANCELLED };

/**
 * Runs `action`; when it answers `reauth_required`, asks `confirm` (the dialog) and, when the user
 * confirmed, runs `action` again exactly once and answers that result (even another
 * `reauth_required`: no loop). When they cancelled, answers {@link CANCELLED} without rerunning.
 */
export async function withReauthRetry<T extends ActionResult>(
  action: () => Promise<T>,
  confirm: () => Promise<boolean>,
): Promise<T | Cancelled> {
  const first = await action();
  if (first.ok || first.code !== REAUTH_REQUIRED) return first;
  if (!(await confirm())) return CANCELLED;
  return action();
}

export interface ReauthOptions {
  methods: ReauthMethod[];
  passkey?: { challenge_id: string; options: { publicKey: Record<string, unknown> } };
  ssoUrl?: string;
  emailCodeSent: boolean;
  retryAfter?: number;
}

export type ReauthResult<T> = ({ ok: true } & T) | { ok: false; code: string; retryAfter?: number };

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const METHODS: readonly ReauthMethod[] = ["passkey", "totp", "email", "sso"];

/** The order the dialog offers methods in: passkey, authenticator code, emailed code (#803). */
export function orderedMethods(methods: readonly string[]): ReauthMethod[] {
  return METHODS.filter((m) => methods.includes(m));
}

function browserEnv(): PasskeyEnv {
  const w = typeof window === "undefined" ? undefined : window;
  return {
    fetch: (...args) => fetch(...args),
    credentials: w?.navigator?.credentials,
    PublicKeyCredential: w?.PublicKeyCredential as unknown as PasskeyEnv["PublicKeyCredential"],
  };
}

async function post(env: Pick<PasskeyEnv, "fetch">, path: string, body: Json, signal?: AbortSignal): Promise<{ status: number; data: Json }> {
  const res = await env.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
    signal,
  });
  let data: Json = {};
  try {
    const parsed: unknown = await res.json();
    if (isObject(parsed)) data = parsed;
  } catch {
    // Not JSON (a proxy error page): the status decides the code below.
  }
  return { status: res.status, data };
}

const failed = (status: number, data: Json) => ({
  ok: false as const,
  code: typeof data.code === "string" ? data.code : status >= 500 ? "server_error" : "unknown_error",
  ...(typeof data.retry_after === "number" ? { retryAfter: data.retry_after } : {}),
});

/** Loads the user's methods; `sendEmailCode` also emails a code now. Never throws. */
export async function reauthOptions(
  input: { sendEmailCode?: boolean; next?: string; signal?: AbortSignal } = {},
  env: Pick<PasskeyEnv, "fetch"> = browserEnv(),
): Promise<ReauthResult<{ options: ReauthOptions }>> {
  try {
    const body: Json = {};
    if (input.sendEmailCode) body.send_email_code = true;
    if (input.next) body.next = input.next;
    const { status, data } = await post(env, "/api/auth/reauth/options", body, input.signal);
    if (status >= 300 || data.ok !== true || !Array.isArray(data.methods)) return failed(status, data);
    const passkey = isObject(data.passkey) && typeof data.passkey.challenge_id === "string" && isObject(data.passkey.options) && isObject(data.passkey.options.publicKey)
      ? { challenge_id: data.passkey.challenge_id, options: data.passkey.options as { publicKey: Json } }
      : undefined;
    return {
      ok: true,
      options: {
        methods: orderedMethods(data.methods.map(String)),
        ...(passkey ? { passkey } : {}),
        ...(typeof data.sso_url === "string" ? { ssoUrl: data.sso_url } : {}),
        emailCodeSent: data.email_code_sent === true,
        ...(typeof data.retry_after === "number" ? { retryAfter: data.retry_after } : {}),
      },
    };
  } catch {
    return { ok: false, code: "network_error" };
  }
}

/** Checks an authenticator or emailed code. Never throws. */
export async function reauthWithCode(
  method: "totp" | "email",
  code: string,
  env: Pick<PasskeyEnv, "fetch"> = browserEnv(),
): Promise<ReauthResult<object>> {
  try {
    const { status, data } = await post(env, "/api/auth/reauth/verify", { method, code: code.trim() });
    return status < 300 && data.ok === true ? { ok: true } : failed(status, data);
  } catch {
    return { ok: false, code: "network_error" };
  }
}

/** Runs the passkey ceremony for `passkey` (from the options). Never throws. */
export async function reauthWithPasskey(
  passkey: NonNullable<ReauthOptions["passkey"]>,
  env: PasskeyEnv = browserEnv(),
): Promise<ReauthResult<object>> {
  if (!passkeysSupported(env)) return { ok: false, code: "unsupported" };
  try {
    const publicKey = requestOptionsFromJSON(passkey.options.publicKey, env.PublicKeyCredential);
    const credential = (await env.credentials!.get({ publicKey, mediation: "optional" })) as PublicKeyCredential | null;
    if (!credential) return { ok: false, code: "cancelled" };
    const { status, data } = await post(env, "/api/auth/reauth/verify", {
      method: "passkey",
      challenge_id: passkey.challenge_id,
      credential: assertionToJSON(credential),
    });
    return status < 300 && data.ok === true ? { ok: true } : failed(status, data);
  } catch (err) {
    if (err instanceof DOMException && (err.name === "AbortError" || err.name === "NotAllowedError")) return { ok: false, code: "cancelled" };
    if (err instanceof TypeError) return { ok: false, code: "network_error" };
    return { ok: false, code: "passkey_failed" };
  }
}

/** User-facing copy for a failed step, or `null` when nothing should be shown. */
export function reauthError(code: string, retryAfter?: number): string | null {
  switch (code) {
    case "cancelled":
      return null;
    case "unsupported":
      return "This browser can’t use passkeys. Use a code instead.";
    case "invalid_code":
    case "invalid_totp":
    case "validation_failed":
      return "That code isn’t right. Check it and try again.";
    case "code_expired":
      return "That code has expired. Request a new one.";
    case "too_many_attempts":
      return "Too many wrong codes. Request a new one.";
    case "passkey_unknown":
      return "That passkey isn’t registered to your account.";
    case "passkey_failed":
      return "That passkey didn’t work. Try again or use a code.";
    case "rate_limited":
      return retryAfter ? `Too many attempts. Try again in ${retryAfter} seconds.` : "Too many attempts. Try again in a moment.";
    case "network_error":
      return "Couldn’t reach APILens. Check your connection and try again.";
    default:
      return "Couldn’t confirm it’s you right now. Try again.";
  }
}
