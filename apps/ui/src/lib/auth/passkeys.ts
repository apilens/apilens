// "Continue with a passkey" on the sign-in page (#319). Two entry points share one ceremony:
//
//   - the button: `mediation: "optional"`, the browser's passkey sheet;
//   - on mount: `mediation: "conditional"`, passkeys offered in the email field's autofill
//     (`autoComplete="email webauthn"`). The page cancels it with an AbortController when the
//     user picks another method.
//
// Ceremony: `POST /api/auth/passkeys/login/options` → `navigator.credentials.get()` →
// `POST /api/auth/passkeys/login/verify` (sets the session cookie) → `{ok: true, next}`.
//
// Client-safe: no server imports. Browser APIs are passed in (`env`) so tests can fake them.

export type PasskeyMediation = "optional" | "conditional";

export type PasskeyResult = { ok: true; next: string } | { ok: false; code: string };

/** `code` of a ceremony the user (or the page, via the AbortSignal) cancelled. Never shown. */
export const PASSKEY_CANCELLED = "cancelled";

/** The browser surface used here; defaults to the real `window`. */
export interface PasskeyEnv {
  fetch: typeof fetch;
  credentials?: Pick<CredentialsContainer, "get">;
  PublicKeyCredential?: PublicKeyCredentialStatics;
}

/** The static side of `PublicKeyCredential` this module touches (all optional: older browsers). */
export interface PublicKeyCredentialStatics {
  isConditionalMediationAvailable?: () => Promise<boolean>;
  parseRequestOptionsFromJSON?: (json: unknown) => PublicKeyCredentialRequestOptions;
}

function browserEnv(): PasskeyEnv {
  const w = typeof window === "undefined" ? undefined : window;
  return {
    fetch: (...args) => fetch(...args),
    credentials: w?.navigator?.credentials,
    PublicKeyCredential: w?.PublicKeyCredential as unknown as PublicKeyCredentialStatics | undefined,
  };
}

/** True when this browser can run a WebAuthn assertion at all (the button is hidden otherwise). */
export function passkeysSupported(env: Partial<PasskeyEnv> = browserEnv()): boolean {
  return typeof env.PublicKeyCredential === "function" && typeof env.credentials?.get === "function";
}

/** True when passkeys can be offered in the email field's autofill (conditional mediation). */
export async function conditionalMediationAvailable(env: Partial<PasskeyEnv> = browserEnv()): Promise<boolean> {
  if (!passkeysSupported(env)) return false;
  const check = env.PublicKeyCredential?.isConditionalMediationAvailable;
  if (typeof check !== "function") return false;
  try {
    return (await check.call(env.PublicKeyCredential)) === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// base64url <-> bytes (WebAuthn JSON encodes every binary field as unpadded base64url)

export function fromBase64Url(value: string): ArrayBuffer {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export function toBase64Url(value: ArrayBuffer | ArrayBufferView): string {
  const bytes =
    value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Turns identity's `options.publicKey` (JSON) into `PublicKeyCredentialRequestOptions`. Uses the
 * browser's own parser when it has one, else decodes the binary fields by hand (Safari < 18.4).
 */
export function requestOptionsFromJSON(
  publicKey: Json,
  statics: PublicKeyCredentialStatics | undefined,
): PublicKeyCredentialRequestOptions {
  if (typeof statics?.parseRequestOptionsFromJSON === "function") {
    return statics.parseRequestOptionsFromJSON.call(statics, publicKey);
  }
  const { challenge, allowCredentials, ...rest } = publicKey;
  if (typeof challenge !== "string") throw new TypeError("options.publicKey.challenge");
  const options = { ...rest, challenge: fromBase64Url(challenge) } as PublicKeyCredentialRequestOptions;
  if (Array.isArray(allowCredentials)) {
    options.allowCredentials = allowCredentials.filter(isObject).map((c) => ({
      ...(c as unknown as PublicKeyCredentialDescriptor),
      id: fromBase64Url(String(c.id)),
    }));
  }
  return options;
}

/** `PublicKeyCredential.toJSON()` for an assertion, with a manual fallback for older browsers. */
export function assertionToJSON(credential: PublicKeyCredential): Json {
  const withJSON = credential as PublicKeyCredential & { toJSON?: () => unknown };
  if (typeof withJSON.toJSON === "function") {
    const json = withJSON.toJSON.call(credential);
    if (isObject(json)) return json;
  }
  const r = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    response: {
      clientDataJSON: toBase64Url(r.clientDataJSON),
      authenticatorData: toBase64Url(r.authenticatorData),
      signature: toBase64Url(r.signature),
      userHandle: r.userHandle ? toBase64Url(r.userHandle) : undefined,
    },
    clientExtensionResults: credential.getClientExtensionResults?.() ?? {},
  };
}

async function post(env: PasskeyEnv, path: string, body: Json, signal?: AbortSignal): Promise<{ status: number; data: Json }> {
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

const failed = (status: number, data: Json): PasskeyResult => ({
  ok: false,
  code: typeof data.code === "string" ? data.code : status >= 500 ? "server_error" : "unknown_error",
});

const sameOrigin = (next: unknown): next is string =>
  typeof next === "string" && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\");

const isAbort = (err: unknown, signal?: AbortSignal) =>
  signal?.aborted === true ||
  (err instanceof DOMException && (err.name === "AbortError" || err.name === "NotAllowedError"));

/**
 * Runs one passkey sign-in. `email` (optional) narrows the browser's choice to that account's
 * passkeys; `next` is where to land. Never throws: a dismissed sheet or an aborted `signal` is
 * `{ok: false, code: "cancelled"}`, transport failures are `network_error`.
 */
export async function signInWithPasskey(
  input: { mediation: PasskeyMediation; signal?: AbortSignal; email?: string; next?: string },
  env: PasskeyEnv = browserEnv(),
): Promise<PasskeyResult> {
  const { mediation, signal } = input;
  if (!passkeysSupported(env)) return { ok: false, code: "unsupported" };
  try {
    const email = input.email?.trim();
    const started = await post(env, "/api/auth/passkeys/login/options", email ? { email } : {}, signal);
    const { challenge_id: challengeId, options } = started.data;
    if (started.status >= 300 || started.data.ok !== true) return failed(started.status, started.data);
    if (typeof challengeId !== "string" || !isObject(options) || !isObject(options.publicKey)) {
      return { ok: false, code: "server_error" };
    }

    let publicKey: PublicKeyCredentialRequestOptions;
    try {
      publicKey = requestOptionsFromJSON(options.publicKey, env.PublicKeyCredential);
    } catch {
      return { ok: false, code: "server_error" };
    }
    const credential = (await env.credentials!.get({ publicKey, mediation, signal })) as PublicKeyCredential | null;
    if (!credential) return { ok: false, code: PASSKEY_CANCELLED };

    const body: Json = { challenge_id: challengeId, credential: assertionToJSON(credential) };
    if (input.next) body.next = input.next;
    const verified = await post(env, "/api/auth/passkeys/login/verify", body, signal);
    if (verified.status < 300 && verified.data.ok === true && sameOrigin(verified.data.next)) {
      return { ok: true, next: verified.data.next };
    }
    return failed(verified.status, verified.data);
  } catch (err) {
    if (isAbort(err, signal)) return { ok: false, code: PASSKEY_CANCELLED };
    if (err instanceof TypeError) return { ok: false, code: "network_error" };
    return { ok: false, code: "passkey_failed" };
  }
}

/** User-facing copy for a failed `signInWithPasskey`, or `null` when nothing should be shown. */
export function passkeyError(code: string): string | null {
  switch (code) {
    case PASSKEY_CANCELLED:
    case "unsupported":
      return null;
    case "passkey_unknown":
      return "No passkey for this account on this device. Use your email instead.";
    case "passkey_failed":
      return "That passkey didn’t work. Try again or use your email instead.";
    case "rate_limited":
      return "Too many attempts. Try again in a moment.";
    case "network_error":
      return "Couldn’t reach APILens. Check your connection and try again.";
    default:
      return "Couldn’t sign in with a passkey right now. Try again or use your email instead.";
  }
}
