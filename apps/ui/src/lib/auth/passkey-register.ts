// "Add a passkey" in Security settings (#341). One ceremony through the Route Handlers:
//
//   `POST /api/auth/passkeys/register/options` → `navigator.credentials.create()` →
//   `POST /api/auth/passkeys/register/verify {challenge_id, credential, name?}` → `{ok, passkey}`.
//
// Client-safe: no server imports. Browser APIs are passed in (`env`) so tests can fake them.
import type { Passkey } from "../identity";
import { PASSKEY_CANCELLED, fromBase64Url, toBase64Url } from "./passkeys";

export type AddPasskeyResult = { ok: true; passkey: Passkey } | { ok: false; code: string };

/** The static side of `PublicKeyCredential` this module touches (optional: older browsers). */
export interface CreationStatics {
  parseCreationOptionsFromJSON?: (json: unknown) => PublicKeyCredentialCreationOptions;
}

/** The browser surface used here; defaults to the real `window`. */
export interface RegisterEnv {
  fetch: typeof fetch;
  credentials?: Pick<CredentialsContainer, "create">;
  PublicKeyCredential?: CreationStatics;
}

function browserEnv(): RegisterEnv {
  const w = typeof window === "undefined" ? undefined : window;
  return {
    fetch: (...args) => fetch(...args),
    credentials: w?.navigator?.credentials,
    PublicKeyCredential: w?.PublicKeyCredential as unknown as CreationStatics | undefined,
  };
}

/** True when this browser can create a passkey at all ("Add a passkey" explains otherwise). */
export function canCreatePasskeys(env: Partial<RegisterEnv> = browserEnv()): boolean {
  return typeof env.PublicKeyCredential === "function" && typeof env.credentials?.create === "function";
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Turns identity's `options.publicKey` (JSON) into `PublicKeyCredentialCreationOptions`. Uses the
 * browser's own parser when it has one, else decodes the binary fields by hand (Safari < 18.4).
 */
export function creationOptionsFromJSON(publicKey: Json, statics: CreationStatics | undefined): PublicKeyCredentialCreationOptions {
  if (typeof statics?.parseCreationOptionsFromJSON === "function") {
    return statics.parseCreationOptionsFromJSON.call(statics, publicKey);
  }
  const { challenge, user, excludeCredentials, ...rest } = publicKey;
  if (typeof challenge !== "string") throw new TypeError("options.publicKey.challenge");
  if (!isObject(user) || typeof user.id !== "string") throw new TypeError("options.publicKey.user");
  const options = {
    ...rest,
    challenge: fromBase64Url(challenge),
    user: { ...user, id: fromBase64Url(user.id) },
  } as unknown as PublicKeyCredentialCreationOptions;
  if (Array.isArray(excludeCredentials)) {
    options.excludeCredentials = excludeCredentials.filter(isObject).map((c) => ({
      ...(c as unknown as PublicKeyCredentialDescriptor),
      id: fromBase64Url(String(c.id)),
    }));
  }
  return options;
}

/** `PublicKeyCredential.toJSON()` for an attestation, with a manual fallback for older browsers. */
export function attestationToJSON(credential: PublicKeyCredential): Json {
  const withJSON = credential as PublicKeyCredential & { toJSON?: () => unknown };
  if (typeof withJSON.toJSON === "function") {
    const json = withJSON.toJSON.call(credential);
    if (isObject(json)) return json;
  }
  const r = credential.response as AuthenticatorAttestationResponse;
  const response: Json = {
    clientDataJSON: toBase64Url(r.clientDataJSON),
    attestationObject: toBase64Url(r.attestationObject),
  };
  if (typeof r.getTransports === "function") response.transports = r.getTransports();
  return {
    id: credential.id,
    rawId: toBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    response,
    clientExtensionResults: credential.getClientExtensionResults?.() ?? {},
  };
}

async function post(env: RegisterEnv, path: string, body: Json): Promise<{ status: number; data: Json }> {
  const res = await env.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
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

const failed = (status: number, data: Json): AddPasskeyResult => ({
  ok: false,
  code: typeof data.code === "string" ? data.code : status >= 500 ? "server_error" : "unknown_error",
});

/**
 * Adds a passkey to the signed-in account, named `name` (identity names it after the
 * authenticator when empty). Never throws: a dismissed browser sheet is `{ok: false, code:
 * "cancelled"}`, an authenticator that already holds one of the user's passkeys is
 * `passkey_already_registered`, transport failures are `network_error`.
 */
export async function addPasskey(input: { name?: string }, env: RegisterEnv = browserEnv()): Promise<AddPasskeyResult> {
  if (!canCreatePasskeys(env)) return { ok: false, code: "unsupported" };
  try {
    const started = await post(env, "/api/auth/passkeys/register/options", {});
    const { challenge_id: challengeId, options } = started.data;
    if (started.status >= 300 || started.data.ok !== true) return failed(started.status, started.data);
    if (typeof challengeId !== "string" || !isObject(options) || !isObject(options.publicKey)) {
      return { ok: false, code: "server_error" };
    }

    let publicKey: PublicKeyCredentialCreationOptions;
    try {
      publicKey = creationOptionsFromJSON(options.publicKey, env.PublicKeyCredential);
    } catch {
      return { ok: false, code: "server_error" };
    }
    let credential: PublicKeyCredential | null;
    try {
      credential = (await env.credentials!.create({ publicKey })) as PublicKeyCredential | null;
    } catch (err) {
      // excludeCredentials matched: this authenticator already holds one of the user's passkeys.
      if (err instanceof DOMException && err.name === "InvalidStateError") return { ok: false, code: "passkey_already_registered" };
      if (err instanceof DOMException && (err.name === "AbortError" || err.name === "NotAllowedError")) {
        return { ok: false, code: PASSKEY_CANCELLED };
      }
      return { ok: false, code: "passkey_failed" };
    }
    if (!credential) return { ok: false, code: PASSKEY_CANCELLED };

    const body: Json = { challenge_id: challengeId, credential: attestationToJSON(credential) };
    const name = input.name?.trim();
    if (name) body.name = name;
    const verified = await post(env, "/api/auth/passkeys/register/verify", body);
    if (verified.status < 300 && verified.data.ok === true && isObject(verified.data.passkey)) {
      return { ok: true, passkey: verified.data.passkey as unknown as Passkey };
    }
    return failed(verified.status, verified.data);
  } catch (err) {
    if (err instanceof TypeError) return { ok: false, code: "network_error" };
    return { ok: false, code: "passkey_failed" };
  }
}
