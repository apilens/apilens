// Server-only typed client for the APILens backend: the `identity` role (sign-in, sessions,
// 2FA, passkeys, invitations) and the `api` role (users/me, orgs, projects, API keys, ingest
// status). Both are served under `APILENS_API_URL` at `/api/v1`.
//
// Tokens never reach the browser: Route Handlers and Server Components call these functions and
// keep the session in the encrypted cookie. Importing this module from a Client Component is a
// build error (`server-only`).
//
// Errors: every non-2xx answer is an RFC 9457 problem (`application/problem+json`, Huma's
// `ErrorModel` in api/openapi/apilens.v1.json) extended with a stable `code` and, when the caller
// must wait, `retry_after`. They surface as {@link ApiError}; branch on `code`, never on `message`.
//
// Types: the committed spec (api/openapi/apilens.v1.json) does not describe the identity and
// org operations yet (#247). Until it does, the shapes below are hand-written from the M2 issue
// contracts and named after the spec's conventions (snake_case JSON). `identity.test.ts` checks
// them against the spec wherever the spec already has the path, so drift fails the tests.
import "server-only";
import { env } from "./env";

// ---------------------------------------------------------------------------------------------
// Errors

/** RFC 9457 problem body as Huma emits it (`ErrorModel`), plus the APILens extensions. */
export interface Problem {
  type?: string;
  title?: string;
  status?: number;
  detail?: string;
  instance?: string;
  errors?: { location?: string; message?: string; value?: unknown }[] | null;
  /** Stable machine-readable error code (identity error catalogue, #244). */
  code?: string;
  /** Seconds to wait before retrying (rate limits, resend cooldowns). */
  retry_after?: number;
  /** `sso_required` only: where the organization's single sign-on starts. */
  start_url?: string;
  /** `slug_taken` only: up to three free alternative slugs. */
  suggestions?: string[];
}

/**
 * Codes the client itself assigns when the server gave none: transport failures (`status` 0)
 * and problems without a `code` extension (mapped from the HTTP status).
 */
export const CLIENT_ERROR_CODES = {
  network: "network_error",
  timeout: "timeout",
  badRequest: "bad_request",
  unauthorized: "unauthorized",
  forbidden: "forbidden",
  notFound: "not_found",
  conflict: "conflict",
  validation: "validation_failed",
  rateLimited: "rate_limited",
  server: "server_error",
  unavailable: "unavailable",
  unknown: "unknown_error",
} as const;

/** A failed backend call. `status` is 0 when no HTTP response arrived. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Seconds to wait before retrying, from `Retry-After` or the problem's `retry_after`. */
  readonly retryAfter: number | null;
  /** The `X-Request-Id` of the failed call, for logs and support. */
  readonly requestId: string | null;
  readonly problem: Problem | null;

  constructor(init: {
    status: number;
    code: string;
    message?: string;
    retryAfter?: number | null;
    requestId?: string | null;
    problem?: Problem | null;
    cause?: unknown;
  }) {
    super(init.message ?? init.code, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.retryAfter = init.retryAfter ?? null;
    this.requestId = init.requestId ?? null;
    this.problem = init.problem ?? null;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/** Fallback `code` for a problem without one, from its HTTP status. */
export function codeForStatus(status: number): string {
  switch (status) {
    case 400:
      return CLIENT_ERROR_CODES.badRequest;
    case 401:
      return CLIENT_ERROR_CODES.unauthorized;
    case 403:
      return CLIENT_ERROR_CODES.forbidden;
    case 404:
      return CLIENT_ERROR_CODES.notFound;
    case 409:
      return CLIENT_ERROR_CODES.conflict;
    case 422:
      return CLIENT_ERROR_CODES.validation;
    case 429:
      return CLIENT_ERROR_CODES.rateLimited;
    case 502:
    case 503:
    case 504:
      return CLIENT_ERROR_CODES.unavailable;
    default:
      return status >= 500 ? CLIENT_ERROR_CODES.server : CLIENT_ERROR_CODES.unknown;
  }
}

/**
 * Parses a `Retry-After` header (delta-seconds or HTTP-date) into whole seconds from `now`.
 * Returns null when absent or unparseable; never negative.
 */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (value == null) return null;
  const raw = value.trim();
  if (raw === "") return null;
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
  // HTTP-date always names the weekday/month; this also stops Date.parse reading "-5" as a year.
  if (!/[a-z]/i.test(raw)) return null;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asProblem(body: unknown): Problem | null {
  if (!isRecord(body)) return null;
  const p: Problem = {};
  for (const key of ["type", "title", "detail", "instance", "code", "start_url"] as const) {
    if (typeof body[key] === "string") p[key] = body[key] as string;
  }
  if (typeof body.status === "number") p.status = body.status;
  if (typeof body.retry_after === "number" && Number.isFinite(body.retry_after)) {
    p.retry_after = Math.max(0, Math.ceil(body.retry_after));
  }
  if (Array.isArray(body.errors)) p.errors = body.errors.filter(isRecord) as Problem["errors"];
  if (Array.isArray(body.suggestions)) p.suggestions = body.suggestions.filter((s): s is string => typeof s === "string");
  return p;
}

/**
 * Turns a non-2xx response into an {@link ApiError}. Never throws. `sentRequestId` is used when
 * the response does not echo `X-Request-Id`.
 */
export async function errorFromResponse(
  res: Response,
  sentRequestId: string | null = null,
  now = Date.now(),
): Promise<ApiError> {
  const requestId = res.headers.get("x-request-id") ?? sentRequestId;
  let problem: Problem | null = null;
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("json")) {
    try {
      problem = asProblem(await res.json());
    } catch {
      problem = null;
    }
  }
  const code = problem?.code?.trim() || codeForStatus(res.status);
  const retryAfter = parseRetryAfter(res.headers.get("retry-after"), now) ?? problem?.retry_after ?? null;
  const message = problem?.detail || problem?.title || `HTTP ${res.status}`;
  return new ApiError({ status: res.status, code, message, retryAfter, requestId, problem });
}

// ---------------------------------------------------------------------------------------------
// Transport

/** Per-call context forwarded to the backend. */
export interface CallOptions {
  /** User access token (RS256 JWT) for authenticated operations. */
  accessToken?: string;
  /** Propagated as `X-Request-Id`; a fresh UUID is generated when omitted. */
  requestId?: string;
  /** Original client address chain, forwarded as `X-Forwarded-For` (rate limits, audit). */
  forwardedFor?: string;
  /** Original browser user agent, forwarded as `User-Agent` (session device labels). */
  userAgent?: string;
  signal?: AbortSignal;
}

/** Picks the forwardable context out of an incoming request's headers. */
export function contextFromHeaders(headers: Headers): Omit<CallOptions, "accessToken" | "signal"> {
  const ctx: Omit<CallOptions, "accessToken" | "signal"> = {};
  const requestId = headers.get("x-request-id");
  if (requestId) ctx.requestId = requestId;
  const forwardedFor = headers.get("x-forwarded-for") ?? headers.get("x-real-ip");
  if (forwardedFor) ctx.forwardedFor = forwardedFor;
  const userAgent = headers.get("user-agent");
  if (userAgent) ctx.userAgent = userAgent;
  return ctx;
}

export interface ClientConfig {
  /** Backend base URL without `/api/v1` and without a trailing slash. */
  baseUrl: string;
  fetch?: typeof fetch;
  /** Per-call timeout in milliseconds (default 10 s). */
  timeoutMs?: number;
}

const API_PREFIX = "/api/v1";
const DEFAULT_TIMEOUT_MS = 10_000;

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type Query = Record<string, string | number | boolean | undefined>;

/** Encodes one path segment (slugs, tokens, ids). */
const seg = (value: string) => encodeURIComponent(value);

function buildUrl(baseUrl: string, path: string, query?: Query): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}${API_PREFIX}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
  }
  return url.href;
}

function makeRequest(config: ClientConfig) {
  const doFetch = config.fetch ?? fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return async function request<T>(
    method: Method,
    path: string,
    opts: CallOptions & { body?: unknown; query?: Query; location?: boolean } = {},
  ): Promise<T> {
    const requestId = opts.requestId ?? crypto.randomUUID();
    const headers = new Headers({
      Accept: "application/json, application/problem+json",
      "X-Request-Id": requestId,
    });
    if (opts.body !== undefined) headers.set("Content-Type", "application/json");
    if (opts.accessToken) headers.set("Authorization", `Bearer ${opts.accessToken}`);
    if (opts.forwardedFor) headers.set("X-Forwarded-For", opts.forwardedFor);
    if (opts.userAgent) headers.set("User-Agent", opts.userAgent);

    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await doFetch(buildUrl(config.baseUrl, path, opts.query), {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        cache: "no-store",
        redirect: "manual",
        signal,
      });
    } catch (err) {
      const timedOut = timeout.aborted && !opts.signal?.aborted;
      throw new ApiError({
        status: 0,
        code: timedOut ? CLIENT_ERROR_CODES.timeout : CLIENT_ERROR_CODES.network,
        message: timedOut
          ? `${method} ${path} timed out after ${timeoutMs} ms`
          : `${method} ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
        requestId,
        cause: err,
      });
    }

    // A browser-navigation endpoint called from the server: the answer is where it redirects.
    if (opts.location && res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (location) return location as T;
    }
    if (!res.ok) throw await errorFromResponse(res, requestId);
    if (res.status === 204 || res.status === 205) return undefined as T;
    const text = await res.text();
    if (text === "") return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new ApiError({
        status: res.status,
        code: CLIENT_ERROR_CODES.unknown,
        message: `${method} ${path} returned a non-JSON body`,
        requestId: res.headers.get("x-request-id") ?? requestId,
        cause: err,
      });
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Shapes (snake_case, as on the wire)

/** `GET /auth/providers` (#256): which sign-in methods this deployment offers. */
export interface AuthProviders {
  email: boolean;
  passkeys: boolean;
  google: boolean;
  github: boolean;
  sso: boolean;
}

/** `GET /auth/sso/lookup` (#299): whether the email's domain signs in through an organization's SSO. */
export interface SSOLookup {
  sso: boolean;
  /** The organization requires SSO: skip the email code and send the browser to `start_url`. */
  enforced: boolean;
  org_name?: string;
  /** Identity's `GET /auth/sso/{org}/start` (absolute); takes `next`, `remember` and `login_hint`. */
  start_url?: string;
}

export type EmailIntent = "signin" | "signup";

export interface EmailStartRequest {
  email: string;
  intent: EmailIntent;
  next?: string;
  remember?: boolean;
}

/** Always returned by `POST /auth/email/start` (#250), whether or not the account exists. */
export interface EmailStartResponse {
  sent: boolean;
  /** Seconds before another code may be requested. */
  retry_after: number;
}

export type AuthMethod = "email" | "google" | "github" | "passkey" | "totp" | "backup_code" | "sso";

export type HomeScreen = "endpoints" | "requests" | "exceptions";

/** `GET /users/me` (#245). */
export interface User {
  id: string;
  email: string;
  email_verified: boolean;
  name: string | null;
  avatar_url: string | null;
  preferences: { home?: HomeScreen; last_project_slug?: string } & Record<string, unknown>;
  onboarding: OnboardingState;
  created_at: string;
  /** Authentication methods of the current session. */
  amr?: AuthMethod[];
}

/** `GET /users/me/identities` (#260): a Google or GitHub account connected to the user. */
export interface ConnectedAccount {
  id: string;
  provider: "google" | "github";
  /** Address the provider reported, or null. */
  email: string | null;
  /** Display name at the provider, or empty. */
  name: string;
  /** Login at the provider (GitHub), or empty. */
  username: string;
  avatar_url: string;
  /** When the account was connected. */
  created_at: string;
  last_login_at: string | null;
}

/** `PATCH /users/me` (#245): omitted fields are left unchanged. */
export interface UpdateMeRequest {
  /** Trimmed by the server; at most 120 characters. */
  name?: string;
  /** An http(s) image URL, or empty to clear it. */
  avatar_url?: string;
  preferences?: Partial<User["preferences"]>;
}

/** `POST /users/me/email/change` (#274): the code went to `pending_email`. */
export interface EmailChangeStarted {
  pending_email: string;
  expires_at: string;
}

/** `DELETE /users/me` (#245): the account is removed for good after `delete_after`. */
export interface AccountDeleted {
  delete_after: string;
}

export interface OnboardingState {
  step: string | null;
  completed: boolean;
  answers?: Record<string, unknown>;
}

/** Answers given during onboarding (`OnboardingAnswers` in the spec); unset ones are omitted. */
export interface OnboardingAnswers {
  org_slug?: string;
  project_slug?: string;
  language?: string;
  runtime?: string;
  method?: string;
  invited?: number;
  /** Id of the ingest key the install step created (#333); the raw key is never saved. */
  api_key_id?: string;
}

/** `PATCH /users/me/onboarding` (#327): omitted fields stay unchanged; answers merge key by key. */
export interface UpdateOnboardingRequest {
  step?: string;
  answers?: OnboardingAnswers;
  completed?: boolean;
}

/** `PATCH /users/me/onboarding` answer (`Onboarding` in the spec). */
export interface Onboarding {
  step: string | null;
  completed: boolean;
  completed_at: string | null;
  answers: OnboardingAnswers;
}

/** Shared by every sign-in method and by refresh (#238). */
export interface SessionBundle {
  access_token: string;
  refresh_token: string;
  /** Access token lifetime in seconds. */
  expires_in: number;
  user: User;
  /** Post-sign-in destination stored with the email token / OAuth state, when any. */
  next?: string | null;
}

/** Second factor required (#251, #269): exchange `pre_auth_token` at `POST /auth/2fa/exchange`. */
export interface TwoFactorRequired {
  status: "2fa_required";
  pre_auth_token: string;
  next?: string | null;
}

/** Result of a first-factor sign-in (email code, magic link, OAuth/SSO handoff). */
export type SignInResult = SessionBundle | TwoFactorRequired;

export function isTwoFactorRequired(result: SignInResult): result is TwoFactorRequired {
  return (result as TwoFactorRequired).status === "2fa_required";
}

export type TwoFactorExchangeRequest =
  | { pre_auth_token: string; code: string }
  | { pre_auth_token: string; backup_code: string };

/** `POST /auth/2fa/enable`: a pending TOTP secret, confirmed by `POST /auth/2fa/verify`. */
export interface TwoFactorEnrollment {
  /** Base32, for typing into an authenticator app. */
  secret: string;
  /** `otpauth://totp/...` key URI, for a QR code. */
  otpauth_uri: string;
}

/** `GET /auth/2fa/status`. */
export interface TwoFactorStatus {
  enabled: boolean;
  confirmed_at: string | null;
  backup_codes_remaining: number;
}

/** `POST /auth/2fa/verify` and `/auth/2fa/backup-codes/regenerate`: shown once. */
export interface BackupCodes {
  backup_codes: string[];
}

/** `POST /auth/2fa/disable`: exactly one of an authenticator code or a backup code. */
export type TwoFactorDisableRequest = { code: string } | { backup_code: string };

/** `POST /auth/passkeys/login/options` (#264). `options` is WebAuthn `PublicKeyCredentialRequestOptions` JSON. */
export interface PasskeyLoginOptions {
  challenge_id: string;
  options: { publicKey: Record<string, unknown> } & Record<string, unknown>;
}

export interface PasskeyLoginVerifyRequest {
  challenge_id: string;
  /** The browser's `PublicKeyCredential` serialised with `toJSON()` (`PasskeyLoginVerifyBody.response`). */
  response: Record<string, unknown>;
  remember?: boolean;
}

/** `POST /auth/passkeys/register/options` (#263). `options` is WebAuthn `PublicKeyCredentialCreationOptions` JSON. */
export interface PasskeyRegisterOptions {
  challenge_id: string;
  options: { publicKey: Record<string, unknown> } & Record<string, unknown>;
}

export interface PasskeyRegisterVerifyRequest {
  challenge_id: string;
  /** The browser's `PublicKeyCredential` from `navigator.credentials.create()`, serialised with `toJSON()`. */
  response: Record<string, unknown>;
  /** Label shown in Security settings (at most 64 characters); identity picks one when omitted. */
  name?: string;
}

/** One of the signed-in user's passkeys (`Passkey` in the spec, #265). */
export interface Passkey {
  id: string;
  name: string;
  /** Authenticator model; all zeros when the authenticator did not say. */
  aaguid: string;
  /** Vendor or product of the AAGUID ("iCloud Keychain", "YubiKey 5"), or empty when unknown. */
  authenticator: string;
  transports: string[] | null;
  /** Whether the passkey can be synced across devices. */
  backup_eligible: boolean;
  /** Whether the passkey is currently synced. */
  backup_state: boolean;
  created_at: string;
  last_used_at: string | null;
}

/** `GET /auth/oidc/requests/{id}` (#301): a client of the built-in OpenID provider asks for a sign-in. */
export interface OidcRequest {
  id: string;
  client_id: string;
  client_name: string;
  scopes: string[];
  /** With "none" no sign-in may be shown. */
  prompt: string[];
  max_age?: number;
  login_hint?: string;
  expires_at: string;
  /** Identity's callback; append `error=login_required` to end the request unsigned. */
  callback_url: string;
}

/** `GET /auth/recovery/status` (#270): where a lost-device recovery request stands. */
export interface RecoveryStatus {
  /** `cancelled` also covers a request replaced by a newer one. */
  status: "pending" | "ready" | "confirmed" | "cancelled";
  requested_at: string;
  /** When the cooling-off period ends and the request can be confirmed. */
  ready_at: string;
}

export type OrgRole = "owner" | "admin" | "member" | "viewer";

export interface OrgRef {
  name: string;
  slug: string;
}

/** Public `GET /auth/invitations/{token}` (#282). */
export interface InvitationPreview {
  org: OrgRef;
  inviter_name: string | null;
  email_masked: string;
  role: OrgRole;
  expires_at: string;
}

/** `POST /auth/invitations/{token}/accept` (#282). */
export interface InvitationAccepted {
  /** The organization, with the user's role in it. */
  org: Org;
  /** False when the invitation was already accepted or the user already belonged to the org. */
  joined: boolean;
}

export interface ContextProject {
  id: string;
  slug: string;
  name: string;
  environments: string[];
}

export interface ContextOrg {
  id: string;
  slug: string;
  name: string;
  role: OrgRole;
  projects: ContextProject[];
}

/** `GET /users/me/context` (#286): everything the app shell needs in one call. */
export interface UserContext {
  user: User;
  orgs: ContextOrg[];
  last_project_slug: string | null;
  onboarding: OnboardingState;
  /** Allowed actions keyed by project slug. */
  capabilities: Record<string, string[]>;
}

/** `GET /users/me/sessions` item (SessionInfo in the spec): one live sign-in of the user. */
export interface SessionInfo {
  /** Changes on every refresh. */
  id: string;
  /** Derived from the user agent at sign-in, e.g. "Chrome on macOS". */
  device_label: string;
  user_agent: string;
  /** Client IP of the last sign-in or refresh; null when unknown. */
  ip: string | null;
  amr: AuthMethod[] | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  /** The session the request was made with. */
  current: boolean;
}

/** `GET /orgs` item and `GET /orgs/{slug}` (#279). */
export interface Org {
  id: string;
  slug: string;
  name: string;
  role: OrgRole;
  allowed_domains?: string[];
  domain_join?: boolean;
  project_count?: number;
  member_count?: number;
  created_at?: string;
}

/** `PATCH /orgs/{slug}` (#279): omitted fields are left unchanged. */
export interface UpdateOrgRequest {
  name?: string;
  /** Must equal the current slug (`slug_immutable` otherwise). */
  slug?: string;
  /** Replaces the list: lower-case hostnames, no public email providers (`domain_not_allowed`). */
  allowed_domains?: string[];
  domain_join?: boolean;
}

/** Role a user gets when they join through their first SSO sign-in. */
export type SSODefaultRole = Exclude<OrgRole, "owner">;

/** `GET`/`PUT /orgs/{slug}/sso` (#300): the organization's OIDC connection. */
export interface SSOConnection {
  issuer: string;
  client_id: string;
  /** Always the mask `********`: the secret is write-only. */
  client_secret: string;
  domains: string[] | null;
  enforce: boolean;
  default_role: SSODefaultRole;
  /** The redirect URI to register with the identity provider. */
  redirect_uri: string;
  /** Where an SSO sign-in to the organization starts. */
  start_url: string;
  created_at: string;
  updated_at: string;
  /** The last successful sign-in through the connection; null if none yet. */
  last_login_at: string | null;
}

/** `PUT /orgs/{slug}/sso` (#300). Omit `client_secret` (or send the mask) to keep the stored one. */
export interface PutSSORequest {
  issuer: string;
  client_id: string;
  client_secret?: string;
  domains: string[];
  enforce?: boolean;
  default_role?: SSODefaultRole;
}

/** `POST /orgs/{slug}/sso/test` (#300): the OIDC discovery outcome; `ok: false` carries `error`. */
export interface SSOTestResult {
  ok: boolean;
  issuer: string;
  error?: "unreachable" | "bad_status" | "invalid_document" | "issuer_mismatch" | "missing_endpoints";
  http_status?: number;
  authorization_endpoint?: string;
  token_endpoint?: string;
  userinfo_endpoint?: string;
  jwks_uri?: string;
  scopes_supported?: string[];
  response_types_supported?: string[];
  id_token_signing_alg_values_supported?: string[];
}

/** `GET /orgs/{slug}/members` item (#280): a member with their user, role and dates. */
export interface Member {
  user: { id: string; email: string; name: string; avatar_url: string };
  role: OrgRole;
  joined_at: string;
  /** Null when they never signed in. */
  last_login_at: string | null;
}

/** The roles an invitation can carry (`owner` comes only from a role change or a transfer). */
export type InviteRole = Exclude<OrgRole, "owner">;

/** One address of `POST /orgs/{slug}/invitations` (#281). */
export interface InviteEntry {
  email: string;
  role: InviteRole;
}

/** `GET /orgs/{slug}/invitations` item (#281): a pending invitation, maybe past its expiry. */
export interface Invitation {
  id: string;
  email: string;
  role: InviteRole;
  created_at: string;
  /** When the emailed link stops working; a pending invitation past it can still be resent. */
  expires_at: string;
  /** When it was last resent; null if never. */
  resent_at: string | null;
  /** Who sent it; absent once their account is gone. */
  invited_by?: { id: string; email: string; name: string };
}

/** `POST /orgs/{slug}/invitations` result, one per requested address in request order. */
export interface InviteResult {
  email: string;
  status: "invited" | "replaced" | "already_member" | "duplicate";
  /** The invitation, when one was emailed (invited, replaced). */
  invitation?: Invitation;
}

/** `GET /users/me/joinable-orgs` item (#283): an organization the user may join by verified email domain. */
export interface JoinableOrg {
  id: string;
  slug: string;
  name: string;
  member_count: number;
  project_count: number;
  /** Initials of up to three members, owners first. */
  member_initials: string[];
}

export interface CreateOrgRequest {
  name: string;
  slug: string;
}

/** `GET /orgs/slug-available` and `GET /projects/slug-available` (#278, #284). */
export interface SlugAvailability {
  available: boolean;
  suggestions: string[];
}

/** `GET /projects/{slug}` and list items (#284). */
export interface Project {
  id: string;
  slug: string;
  name: string;
  org_slug?: string;
  environments: string[];
  created_at?: string;
}

export interface CreateProjectRequest {
  name: string;
  slug: string;
  environments?: string[];
}

export type ApiKeyScope = "ingest" | "read";

/** `GET /projects/{slug}/api-keys` item (#285). */
export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  last_used_at: string | null;
  created_at: string;
  expires_at?: string | null;
  revoked_at: string | null;
}

export interface CreateApiKeyRequest {
  name: string;
  scopes: ApiKeyScope[];
  expires_at?: string;
}

/** `POST /projects/{slug}/api-keys`: the raw `key` is returned exactly once. */
export interface CreatedApiKey extends ApiKey {
  key: string;
}

/** `GET /projects/{slug}/ingest-status` (#287). */
export interface IngestStatus {
  received: boolean;
  first_at: string | null;
  last_at: string | null;
  count_1h: number;
}

// Query role (internal/query, #295): with a session the project is the `project` query parameter
// and the caller needs `project.view`. Shapes as in api/openapi/apilens.v1.json.

/** Time range of the traffic operations, ending now. */
export type QueryRange = "1h" | "6h" | "24h" | "7d";

/** One row of `GET /requests`, newest first. */
export interface RequestRow {
  /** Opaque request id for `GET /requests/{id}` (#577); the request drawer (#588) reads it. */
  id?: string;
  timestamp: string;
  method: string;
  /** Route template, e.g. `/orders/{id}`. */
  path: string;
  /** The URL as requested, e.g. `/orders/42?full=1`. */
  raw_path: string;
  status_code: number;
  response_time_ms: number;
  environment: string;
  consumer_id: string;
  consumer_name: string;
  trace_id: string;
  /** Request and response body sizes in bytes (#576). */
  request_size?: number;
  response_size?: number;
  /** False when the SDK sampled the request out: a base record without headers or bodies. */
  sampled?: boolean;
  consumer_group?: string;
  ip_address?: string;
  app_id?: string;
}

/** A field error of a rejected request (usually a 422), as `GET /requests/{id}` parses it (#577). */
export interface RequestValidationError {
  loc: string;
  msg: string;
  type: string;
}

/**
 * One request as `GET /requests/{id}` answers it (#577): the log row plus what only the request
 * drawer (#588) shows. Headers and bodies are the stored text, redaction (`[redacted]`, `[masked]`)
 * and truncation (`...[truncated]`) markers kept; empty when the SDK did not capture them.
 */
export interface RequestDetail extends RequestRow {
  id: string;
  span_id: string;
  user_agent: string;
  base_url: string;
  release: string;
  commit: string;
  request_headers: string;
  response_headers: string;
  request_body: string;
  response_body: string;
  attributes: Record<string, string> | null;
  validation_errors: RequestValidationError[] | null;
}

/** One span of a trace, as `GET /requests/{id}` and `GET /traces/{trace_id}` answer it. */
export interface TraceSpan {
  span_id: string;
  parent_span_id: string;
  name: string;
  kind: string;
  service_name: string;
  start: string;
  duration_ms: number;
  status: string;
  status_code: number;
  attributes: Record<string, string> | null;
}

/** One log line of a trace. */
export interface TraceLog {
  timestamp: string;
  level: string;
  message: string;
  span_id: string;
}

/** `GET /requests/{id}`: the request with the spans and logs of its trace, oldest first. */
export interface RequestDetailRead {
  request: RequestDetail;
  spans: TraceSpan[] | null;
  logs: TraceLog[] | null;
}

/**
 * The filters of `GET /requests` (#576), as query parameters: equality on env, method, path,
 * consumer, group and IP; case-insensitive substrings on the URL and the bodies; status codes,
 * classes and ranges (`4xx,500-503`); inclusive size and latency bounds; sampled `true`/`false`.
 */
export type RequestLogFilters = Partial<
  Record<
    | "env"
    | "method"
    | "status"
    | "path"
    | "url_contains"
    | "payload_contains"
    | "consumer_id"
    | "consumer_group"
    | "ip"
    | "request_size_min"
    | "request_size_max"
    | "response_size_min"
    | "response_size_max"
    | "latency_min"
    | "latency_max"
    | "sampled",
    string
  >
>;

/** A narrower window inside the range (#587), RFC 3339; `GET /requests` and its timeline clamp it to the range. */
export interface RequestWindow {
  from?: string;
  to?: string;
}

/** One bucket of `GET /requests/timeline` (#587), oldest first. */
export interface RequestTimelineBucket {
  ts: string;
  requests: number;
  /** Status below 400. */
  successful: number;
  client_errors: number;
  server_errors: number;
}

/** `GET /requests/timeline` (#587): the filtered request log counted per bucket by status class. */
export interface RequestTimeline {
  from: string;
  to: string;
  bucket_seconds: number;
  buckets: RequestTimelineBucket[] | null;
}

/** `GET /traffic/summary`. */
export interface TrafficSummary {
  range: string;
  from: string;
  to: string;
  requests: number;
  client_errors: number;
  server_errors: number;
  error_rate: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  requests_per_minute: number;
  /** Apdex from 0 to 1 against each endpoint's latency threshold (else its app's, else 500 ms); null without requests. */
  apdex?: number | null;
}

/** One row of `GET /traffic/endpoints`. */
export interface EndpointTraffic {
  method: string;
  path: string;
  requests: number;
  client_errors: number;
  server_errors: number;
  error_rate: number;
  p50_ms: number;
  p95_ms: number;
  /** Apdex from 0 to 1 against the endpoint's latency threshold; null without requests. */
  apdex?: number | null;
}

/** One bucket of `GET /traffic/timeseries`, oldest first. */
export interface TrafficPoint {
  ts: string;
  requests: number;
  client_errors: number;
  server_errors: number;
  p95_ms: number;
}

/** `GET /traffic/timeseries`. */
export interface TrafficTimeseries {
  range: string;
  bucket_seconds: number;
  points: TrafficPoint[] | null;
}

/** The scope of the traffic reads: a range ending now and an environment (empty or absent means all). */
export interface TrafficQuery {
  range?: QueryRange;
  env?: string;
}

/** Traffic on one side of a deploy in `GET /deploys/changes`; rates and p95 are 0 without requests. */
export interface DeploySide {
  requests: number;
  error_rate: number;
  p95_ms: number;
}

/** One deploy of `GET /deploys/changes` (#597), newest first. */
export interface DeployChange {
  deployed_at: string;
  release: string;
  commit: string;
  environment: string;
  url: string;
  /** The deployed app's id; empty for a project-wide deploy. */
  app_id: string;
  /** The hour before the deploy's minute. */
  before: DeploySide;
  /** The hour after the deploy's minute; the minute itself is in neither side. */
  after: DeploySide;
  /** The after window is still open: it covers less than an hour so far. */
  after_partial: boolean;
}

/** `GET /deploys/changes`. */
export interface DeployChanges {
  window_minutes: number;
  deploys: DeployChange[] | null;
}

/** Requests split by status class, as the consumers operations report them. */
export interface StatusSplit {
  requests: number;
  /** Status below 400. */
  successful: number;
  client_errors: number;
  server_errors: number;
}

/** The consumer group a consumer is in. */
export interface ConsumerGroupRef {
  id: string;
  name: string;
}

/** Unique consumers in a period, split by whether they were first seen in it. */
export interface ConsumerCounts {
  consumers: number;
  new: number;
  returning: number;
}

/** One consumer of `GET /consumers` (#580), by requests. */
export interface ConsumerRow extends StatusSplit {
  consumer_id: string;
  consumer_name: string;
  /** Absent when the consumer is in no group. */
  group?: ConsumerGroupRef | null;
  first_seen: string;
  last_seen: string;
  /** First seen within the range. */
  new: boolean;
  /** Requests per bucket of the range, oldest first. */
  sparkline: number[] | null;
}

/** `GET /consumers`. */
export interface ConsumersList {
  range: string;
  from: string;
  to: string;
  bucket_seconds: number;
  summary: ConsumerCounts;
  /** Unique consumers per bucket; new means first seen within that bucket. */
  points: (ConsumerCounts & { ts: string })[] | null;
  consumers: ConsumerRow[] | null;
}

/** `GET /consumers/{consumer_id}`. */
export interface ConsumerDetail {
  consumer_id: string;
  consumer_name: string;
  group?: ConsumerGroupRef | null;
  first_seen: string;
  last_seen: string;
  new: boolean;
  range: string;
  from: string;
  to: string;
  bucket_seconds: number;
  summary: StatusSplit & { requests_per_minute: number };
  points: (StatusSplit & { ts: string })[] | null;
  recent_requests: RequestRow[] | null;
  recent_errors: RequestRow[] | null;
}

/** One group of `GET /projects/{slug}/consumer-groups`. */
export interface ConsumerGroup {
  id: string;
  name: string;
  /** How many consumers are assigned to it. */
  consumers: number;
  created_at: string;
  updated_at: string;
}

/** An app of a project, as `GET /project` lists it. */
export interface NamedApp {
  id: string;
  slug: string;
  name: string;
}

/** `GET /project?project=` (query role): the project, its apps and its recent environments. */
export interface ProjectApps {
  apps: NamedApp[] | null;
  environments: string[] | null;
}

/** `GET|PUT /apps/{id}/capture-policy` (#566): the remote capture policy of an app. */
export interface CapturePolicy {
  app_id: string;
  app: string;
  project: string;
  enabled: boolean;
  /** 0 to 1, at most 4 decimal places. */
  sample_rate: number;
  capture_headers: boolean;
  capture_request_body: boolean;
  capture_response_body: boolean;
  /** Bytes; null means no cap beyond the SDK's own. */
  max_payload_bytes: number | null;
  /** Null when the policy was never saved (the app captures everything). */
  updated_at: string | null;
  updated_by: string | null;
}

export type PutCapturePolicyRequest = Pick<
  CapturePolicy,
  "enabled" | "sample_rate" | "capture_headers" | "capture_request_body" | "capture_response_body" | "max_payload_bytes"
>;

/** One environment of `GET /apps/{id}/metadata` (#598): what the app's SDK reported on startup. */
export interface AppEnvironmentReport {
  environment: string;
  framework: string;
  framework_version: string;
  runtime_version: string;
  sdk_version: string;
  /** The effective SDK config as reported; keys depend on the SDK. */
  config: Record<string, unknown>;
  received_at: string;
}

/** `GET /apps/{id}/metadata`. */
export interface AppReports {
  app_id: string;
  environments: AppEnvironmentReport[] | null;
}

// Ingest health (#602): the ingest edge's per-app counters (`GET /apps/{id}/ingest-stats`, #569)
// and the SDK delivery counters of `GET /apps/{id}/status` (#582). Shapes as in
// api/openapi/apilens.v1.json.

/** Records the ingest edge accepted, rejected, truncated and masked for an app. */
export interface IngestCounts {
  accepted: number;
  rejected: number;
  truncated: number;
  masked: number;
}

/** One UTC day of `IngestCounts`; `date` is `YYYY-MM-DD`. */
export interface IngestDay extends IngestCounts {
  date: string;
}

/** `GET /apps/{id}/ingest-stats?days=`: oldest day first; 503 when the counter store is not configured. */
export interface AppIngestStats {
  app_id: string;
  app: string;
  days: number;
  totals: IngestCounts;
  daily: IngestDay[] | null;
}

/** SDK delivery counters summed over the instances seen in the last hour. */
export interface AppSdkStats {
  instances: number;
  queued_records: number;
  sent_records: number;
  failed_batches: number;
  dropped_records: number;
  /** `dropped_records` by reason, as the SDKs name them (`queue_full`, `retries_exhausted`, ...). */
  drop_counts: Record<string, number>;
}

/** The part of `GET /apps/{id}/status` the ingest health panel reads. */
export interface AppHealthStatus {
  app_id: string;
  app: string;
  status: "reporting" | "stale" | "silent" | "never";
  last_seen_at: string | null;
  sdk_stats: AppSdkStats;
  ingest_today?: IngestCounts;
}

/** The built-in patterns of `GET|PUT /projects/{slug}/privacy-policy`, applied always. */
export interface PrivacyDefaults {
  mask_query_params: string[] | null;
  mask_headers: string[] | null;
  /** Header names (lower case, matched exactly). */
  sensitive_headers: string[] | null;
  mask_body_fields: string[] | null;
}

/** `GET|PUT /projects/{slug}/privacy-policy` (#562): the project's server-side deny list. */
export interface PrivacyPolicy {
  /** The app slug the policy is scoped to; null for the project-wide policy. */
  app: string | null;
  /** Case-insensitive RE2 patterns, on top of the defaults. */
  mask_query_params: string[] | null;
  mask_headers: string[] | null;
  mask_body_fields: string[] | null;
  defaults: PrivacyDefaults;
  /** Null when the policy was never saved (only the defaults apply). */
  updated_at: string | null;
}

export interface PutPrivacyPolicyRequest {
  mask_query_params: string[];
  mask_headers: string[];
  mask_body_fields: string[];
}

// Endpoint detail (#571, #572, #573), read by the endpoint page (#593). Shapes as in
// api/openapi/apilens.v1.json; the path is the route template, sent as one encoded segment.

/** Status class filter of the endpoint reads (the errors read takes none). */
export type StatusClass = "all" | "2xx" | "3xx" | "4xx" | "5xx";

/** The scope of the endpoint reads: range, environment, status class and consumer; empty means all. */
export interface EndpointQuery {
  range?: QueryRange;
  env?: string;
  status?: StatusClass;
  consumer?: string;
}

/** The time frame every endpoint read answers with. */
interface EndpointFrame {
  method: string;
  path: string;
  range: string;
  from: string;
  to: string;
  bucket_seconds: number;
}

/** A top consumer of an endpoint. */
export interface EndpointConsumer extends StatusSplit {
  consumer_id: string;
  consumer_name: string;
}

/** `GET /endpoints/{method}/{path}/requests`. */
export interface EndpointRequests extends EndpointFrame {
  summary: StatusSplit & { requests_per_minute: number };
  points: (StatusSplit & { ts: string })[] | null;
  /** Top consumers by requests (at most 10). */
  consumers: EndpointConsumer[] | null;
}

/** Errors with their rates; expected status codes are not errors. */
export interface ErrorSplit {
  requests: number;
  client_errors: number;
  server_errors: number;
  client_error_rate: number;
  server_error_rate: number;
}

/** An error status code of an endpoint. */
export interface EndpointStatusCount {
  status_code: number;
  count: number;
  share: number;
  consumers: number;
  last_seen: string;
}

/** Validation errors grouped by (loc, msg, type). */
export interface EndpointValidationError {
  loc: string;
  msg: string;
  type: string;
  count: number;
  consumers: number;
  last_seen: string;
}

/** Server exceptions grouped by (exception_type, message), with the latest stack trace. */
export interface EndpointException {
  exception_type: string;
  message: string;
  count: number;
  consumers: number;
  first_seen: string;
  last_seen: string;
  stack_trace: string;
  trace_id: string;
}

/** `GET /endpoints/{method}/{path}/errors`. */
export interface EndpointErrors extends EndpointFrame {
  summary: ErrorSplit;
  points: (ErrorSplit & { ts: string })[] | null;
  statuses: EndpointStatusCount[] | null;
  validation_errors: EndpointValidationError[] | null;
  exceptions: EndpointException[] | null;
}

/** A response-time histogram bucket; the last has no `to_ms`. */
export interface LatencyBucket {
  from_ms: number;
  to_ms?: number;
  count: number;
}

/** `GET /endpoints/{method}/{path}/latency`. */
export interface EndpointLatency extends EndpointFrame {
  summary: {
    requests: number;
    avg_ms: number;
    max_ms: number;
    p50_ms: number;
    p75_ms: number;
    p90_ms: number;
    p95_ms: number;
    p99_ms: number;
    apdex: number | null;
  };
  points: { ts: string; requests: number; p50_ms: number; p75_ms: number; p95_ms: number }[] | null;
  /** 14 log-spaced buckets. */
  histogram: LatencyBucket[] | null;
}

/** A body-size histogram bucket; the last has no `to_bytes`. */
export interface SizeBucket {
  from_bytes: number;
  to_bytes?: number;
  count: number;
}

/** `GET /endpoints/{method}/{path}/transfer`. */
export interface EndpointTransfer extends EndpointFrame {
  summary: { requests: number; request_bytes: number; response_bytes: number; avg_request_bytes: number; avg_response_bytes: number };
  points: { ts: string; requests: number; request_bytes: number; response_bytes: number }[] | null;
  request_size_histogram: SizeBucket[] | null;
  response_size_histogram: SizeBucket[] | null;
}

/** `GET|PUT /apps/{id}/endpoints/{method}/{path}/settings`. */
export interface EndpointSettings {
  app_id: string;
  method: string;
  path: string;
  expected_status_codes: number[] | null;
  /** Null means the app default. */
  latency_threshold_ms: number | null;
  excluded: boolean;
  /** Null when never saved (the defaults apply). */
  updated_at: string | null;
}

export interface PutEndpointSettingsRequest {
  expected_status_codes: number[];
  latency_threshold_ms: number | null;
  excluded: boolean;
}

// Errors dashboard, status-centric (#581), read by the Errors page (#594). Expected status codes
// of each endpoint are not errors and excluded endpoints are left out, as on every dashboard read.

/** An error status code over the range: `GET /errors/status` → statuses. */
export interface ErrorStatusRow {
  status_code: number;
  count: number;
  /** count / requests of the range. */
  share: number;
  endpoints: number;
  consumers: number;
  first_seen: string;
  last_seen: string;
}

/** `GET /errors/status`. */
export interface ErrorStatuses {
  range: string;
  from: string;
  to: string;
  bucket_seconds: number;
  summary: ErrorSplit;
  points: (ErrorSplit & { ts: string })[] | null;
  /** Occurrences of each error status code per bucket, aligned with points, in statuses order. */
  series: { status_code: number; counts: number[] | null }[] | null;
  statuses: ErrorStatusRow[] | null;
}

/** An endpoint that answered with the status code: `GET /errors/status/{code}` → endpoint_breakdown. */
export interface ErrorStatusEndpoint {
  method: string;
  path: string;
  count: number;
  consumers: number;
  last_seen: string;
  validation_errors: number;
  exceptions: number;
}

/** A consumer that got the status code: `GET /errors/status/{code}` → consumer_breakdown. */
export interface ErrorStatusConsumer {
  consumer_id: string;
  consumer_name: string;
  count: number;
  /** count / occurrences. */
  share: number;
  first_seen: string;
  last_seen: string;
}

/** `GET /errors/status/{code}`. */
export interface ErrorStatusDetail {
  status_code: number;
  range: string;
  from: string;
  to: string;
  bucket_seconds: number;
  occurrences: number;
  requests: number;
  share: number;
  per_hour: number;
  consumers: number;
  anonymous: number;
  endpoints: number;
  first_seen: string | null;
  last_seen: string | null;
  points: { ts: string; count: number }[] | null;
  endpoint_breakdown: ErrorStatusEndpoint[] | null;
  consumer_breakdown: ErrorStatusConsumer[] | null;
}

/** Failed requests grouped by endpoint and status: `GET /errors` → errors. */
export interface ErrorGroup {
  method: string;
  path: string;
  status_code: number;
  count: number;
  consumers: number;
  last_seen: string;
}

// Performance (#595): the project's response times and the app-wide Apdex threshold.

/** `GET /traffic/latency`: the project's response-time report, excluded endpoints left out. */
export interface TrafficLatency {
  range: string;
  from: string;
  to: string;
  bucket_seconds: number;
  summary: EndpointLatency["summary"];
  points: EndpointLatency["points"];
  /** 14 log-spaced buckets. */
  histogram: LatencyBucket[] | null;
}

/** `GET|PUT /apps/{id}/settings`: the app-wide latency (Apdex) threshold. */
export interface AppSettings {
  app_id: string;
  /** Null means the default of 500 ms. */
  latency_threshold_ms: number | null;
  /** The threshold in effect for the app's endpoints without their own. */
  apdex_threshold_ms: number;
}

// ---------------------------------------------------------------------------------------------
// Operations

/**
 * The typed client. Paths are relative to `/api/v1`. Each operation takes an optional
 * {@link CallOptions} last; authenticated ones require `accessToken`.
 */
/** The traffic reads' `range` and `env` query parameters; an empty environment is left out (all). */
function trafficScope(q: QueryRange | TrafficQuery): { range?: QueryRange; env?: string } {
  const { range, env } = typeof q === "string" ? { range: q, env: undefined } : q;
  return { ...(range ? { range } : {}), ...(env ? { env } : {}) };
}

/** The endpoint reads' query parameters; empty values and the `all` status are left out. */
function endpointScope(q: EndpointQuery): Query {
  return {
    ...trafficScope(q),
    ...(q.status && q.status !== "all" ? { status: q.status } : {}),
    ...(q.consumer ? { consumer: q.consumer } : {}),
  };
}

export function createClient(config: ClientConfig) {
  const request = makeRequest(config);
  type Authed = CallOptions & { accessToken: string };

  return {
    // identity: sign-in -------------------------------------------------------------------
    providers: (o?: CallOptions) => request<AuthProviders>("GET", "/auth/providers", o),
    ssoLookup: (email: string, o?: CallOptions) =>
      request<SSOLookup>("GET", "/auth/sso/lookup", { ...o, query: { email } }),
    emailStart: (body: EmailStartRequest, o?: CallOptions) =>
      request<EmailStartResponse>("POST", "/auth/email/start", { ...o, body }),
    emailVerify: (body: { email: string; code: string; remember?: boolean }, o?: CallOptions) =>
      request<SignInResult>("POST", "/auth/email/verify", { ...o, body }),
    emailVerifyLink: (body: { token: string; remember?: boolean }, o?: CallOptions) =>
      request<SignInResult>("POST", "/auth/email/verify-link", { ...o, body }),
    handoff: (body: { code: string }, o?: CallOptions) =>
      request<SignInResult>("POST", "/auth/handoff", { ...o, body }),
    twoFactorExchange: (body: TwoFactorExchangeRequest, o?: CallOptions) =>
      request<SessionBundle>("POST", "/auth/2fa/exchange", { ...o, body }),
    passkeyLoginOptions: (body: { email?: string } = {}, o?: CallOptions) =>
      request<PasskeyLoginOptions>("POST", "/auth/passkeys/login/options", { ...o, body }),
    passkeyLoginVerify: (body: PasskeyLoginVerifyRequest, o?: CallOptions) =>
      request<SessionBundle>("POST", "/auth/passkeys/login/verify", { ...o, body }),
    passkeyRegisterOptions: (o: Authed) =>
      request<PasskeyRegisterOptions>("POST", "/auth/passkeys/register/options", o),
    passkeyRegisterVerify: (body: PasskeyRegisterVerifyRequest, o: Authed) =>
      request<Passkey>("POST", "/auth/passkeys/register/verify", { ...o, body }),

    // identity: OpenID provider sign-in (#301) ---------------------------------------------
    oidcRequest: (id: string, o?: CallOptions) =>
      request<OidcRequest>("GET", `/auth/oidc/requests/${seg(id)}`, o),
    oidcComplete: (id: string, o: Authed) =>
      request<{ redirect_to: string }>("POST", `/auth/oidc/requests/${seg(id)}/complete`, o),
    // identity: account recovery (2FA device lost) -----------------------------------------
    recoveryRequest: (body: { email: string }, o?: CallOptions) =>
      request<{ sent: boolean }>("POST", "/auth/recovery/request", { ...o, body }),
    recoveryStatus: (token: string, o?: CallOptions) =>
      request<RecoveryStatus>("GET", "/auth/recovery/status", { ...o, query: { token } }),
    recoveryConfirm: (body: { token: string }, o?: CallOptions) =>
      request<SessionBundle>("POST", "/auth/recovery/confirm", { ...o, body }),
    recoveryCancel: (body: { token: string }, o?: CallOptions) =>
      request<void>("POST", "/auth/recovery/cancel", { ...o, body }),

    // identity: two-factor settings (#342) ------------------------------------------------
    twoFactorStatus: (o: Authed) => request<TwoFactorStatus>("GET", "/auth/2fa/status", o),
    twoFactorEnable: (o: Authed) => request<TwoFactorEnrollment>("POST", "/auth/2fa/enable", o),
    twoFactorVerify: (body: { code: string }, o: Authed) =>
      request<BackupCodes>("POST", "/auth/2fa/verify", { ...o, body }),
    twoFactorDisable: (body: TwoFactorDisableRequest, o: Authed) =>
      request<void>("POST", "/auth/2fa/disable", { ...o, body }),
    twoFactorRegenerate: (body: { code: string }, o: Authed) =>
      request<BackupCodes>("POST", "/auth/2fa/backup-codes/regenerate", { ...o, body }),

    // identity: sessions ------------------------------------------------------------------
    refresh: (body: { refresh_token: string }, o?: CallOptions) =>
      request<SessionBundle>("POST", "/auth/refresh", { ...o, body }),
    logout: (body: { refresh_token: string }, o?: CallOptions) =>
      request<void>("POST", "/auth/logout", { ...o, body }),

    // identity / api: current user --------------------------------------------------------
    me: (o: Authed) => request<User>("GET", "/users/me", o),
    context: (o: Authed) => request<UserContext>("GET", "/users/me/context", o),
    updateMe: (body: UpdateMeRequest, o: Authed) => request<User>("PATCH", "/users/me", { ...o, body }),
    updateOnboarding: (body: UpdateOnboardingRequest, o: Authed) =>
      request<Onboarding>("PATCH", "/users/me/onboarding", { ...o, body }),
    deleteMe: (o: Authed) => request<AccountDeleted>("DELETE", "/users/me", o),
    startEmailChange: (body: { new_email: string }, o: Authed) =>
      request<EmailChangeStarted>("POST", "/users/me/email/change", { ...o, body }),
    confirmEmailChange: (body: { code: string }, o: Authed) =>
      request<User>("POST", "/users/me/email/confirm", { ...o, body }),

    // identity: the signed-in user's sessions ---------------------------------------------
    listSessions: (o: Authed) => request<{ sessions: SessionInfo[] }>("GET", "/users/me/sessions", o),
    revokeSession: (id: string, o: Authed) => request<void>("DELETE", `/users/me/sessions/${seg(id)}`, o),
    revokeOtherSessions: (o: Authed) =>
      request<{ revoked: number }>("POST", "/users/me/sessions/revoke-others", o),
    // identity: connected accounts (#260) --------------------------------------------------
    listIdentities: (o: Authed) =>
      request<{ identities: ConnectedAccount[] }>("GET", "/users/me/identities", o),
    deleteIdentity: (id: string, o: Authed) => request<void>("DELETE", `/users/me/identities/${seg(id)}`, o),
    /**
     * `GET /auth/oauth/{provider}/start?intent=link` as the signed-in user: answers the provider
     * URL identity redirects to, for the browser to follow. `next` is where identity sends it back.
     */
    oauthLinkStart: (provider: "google" | "github", next: string, o: Authed) =>
      request<string>("GET", `/auth/oauth/${seg(provider)}/start`, {
        ...o,
        query: { intent: "link", next },
        location: true,
      }),
    // identity: the signed-in user's passkeys (#265) --------------------------------------
    listMyPasskeys: (o: Authed) => request<{ passkeys: Passkey[] | null }>("GET", "/users/me/passkeys", o),
    renameMyPasskey: (id: string, body: { name: string }, o: Authed) =>
      request<Passkey>("PATCH", `/users/me/passkeys/${seg(id)}`, { ...o, body }),
    deleteMyPasskey: (id: string, o: Authed) => request<void>("DELETE", `/users/me/passkeys/${seg(id)}`, o),

    // api: invitations --------------------------------------------------------------------
    invitationLookup: (token: string, o?: CallOptions) =>
      request<InvitationPreview>("GET", `/auth/invitations/${seg(token)}`, o),
    invitationAccept: (token: string, o: Authed) =>
      request<InvitationAccepted>("POST", `/auth/invitations/${seg(token)}/accept`, o),

    // api: organizations ------------------------------------------------------------------
    listOrgs: (o: Authed) => request<Org[]>("GET", "/orgs", o),
    getOrg: (slug: string, o: Authed) => request<Org>("GET", `/orgs/${seg(slug)}`, o),
    updateOrg: (slug: string, body: UpdateOrgRequest, o: Authed) =>
      request<Org>("PATCH", `/orgs/${seg(slug)}`, { ...o, body }),
    deleteOrg: (slug: string, o: Authed) => request<void>("DELETE", `/orgs/${seg(slug)}`, o),
    createOrg: (body: CreateOrgRequest, o: Authed) =>
      request<Org>("POST", "/orgs", { ...o, body }),
    orgSlugAvailable: (slug: string, o: Authed) =>
      request<SlugAvailability>("GET", "/orgs/slug-available", { ...o, query: { slug } }),
    // Verified-domain join (#283): `forbidden` when the organization is missing or not joinable.
    listJoinableOrgs: (o: Authed) => request<JoinableOrg[] | null>("GET", "/users/me/joinable-orgs", o),
    joinOrg: (slug: string, o: Authed) => request<Org>("POST", `/orgs/${seg(slug)}/join`, o),

    // api: organization SSO connection (#300) -----------------------------------------------
    getOrgSSO: (slug: string, o: Authed) => request<SSOConnection>("GET", `/orgs/${seg(slug)}/sso`, o),
    putOrgSSO: (slug: string, body: PutSSORequest, o: Authed) =>
      request<SSOConnection>("PUT", `/orgs/${seg(slug)}/sso`, { ...o, body }),
    deleteOrgSSO: (slug: string, o: Authed) => request<void>("DELETE", `/orgs/${seg(slug)}/sso`, o),
    testOrgSSO: (slug: string, issuer: string | undefined, o: Authed) =>
      request<SSOTestResult>("POST", `/orgs/${seg(slug)}/sso/test`, { ...o, body: issuer ? { issuer } : {} }),

    // api: organization members (#280) and invitations (#281) ---------------------------------
    listMembers: (slug: string, o: Authed) =>
      request<Member[] | null>("GET", `/orgs/${seg(slug)}/members`, o),
    changeMemberRole: (slug: string, userId: string, role: OrgRole, o: Authed) =>
      request<Member>("PATCH", `/orgs/${seg(slug)}/members/${seg(userId)}`, { ...o, body: { role } }),
    removeMember: (slug: string, userId: string, o: Authed) =>
      request<void>("DELETE", `/orgs/${seg(slug)}/members/${seg(userId)}`, o),
    transferOwnership: (slug: string, userId: string, o: Authed) =>
      request<void>("POST", `/orgs/${seg(slug)}/transfer-ownership`, { ...o, body: { user_id: userId } }),
    createInvitations: (slug: string, invites: InviteEntry[], o: Authed) =>
      request<{ results: InviteResult[] | null }>("POST", `/orgs/${seg(slug)}/invitations`, { ...o, body: { invites } }),
    listInvitations: (slug: string, o: Authed) =>
      request<Invitation[] | null>("GET", `/orgs/${seg(slug)}/invitations`, o),
    resendInvitation: (slug: string, id: string, o: Authed) =>
      request<Invitation>("POST", `/orgs/${seg(slug)}/invitations/${seg(id)}/resend`, o),
    revokeInvitation: (slug: string, id: string, o: Authed) =>
      request<void>("DELETE", `/orgs/${seg(slug)}/invitations/${seg(id)}`, o),

    // api: projects -----------------------------------------------------------------------
    listProjects: (orgSlug: string, o: Authed) =>
      request<Project[]>("GET", `/orgs/${seg(orgSlug)}/projects`, o),
    createProject: (orgSlug: string, body: CreateProjectRequest, o: Authed) =>
      request<Project>("POST", `/orgs/${seg(orgSlug)}/projects`, { ...o, body }),
    getProject: (slug: string, o: Authed) => request<Project>("GET", `/projects/${seg(slug)}`, o),
    projectSlugAvailable: (slug: string, o: Authed) =>
      request<SlugAvailability>("GET", "/projects/slug-available", { ...o, query: { slug } }),
    ingestStatus: (projectSlug: string, o: Authed) =>
      request<IngestStatus>("GET", `/projects/${seg(projectSlug)}/ingest-status`, o),

    // query: dashboard reads as the signed-in user (#295) ----------------------------------
    listRequests: (projectSlug: string, q: { range?: QueryRange; limit?: number } & RequestWindow & RequestLogFilters, o: Authed) =>
      request<{ requests: RequestRow[] | null; next_cursor?: string }>("GET", "/requests", { ...o, query: { project: projectSlug, ...q } }),
    requestTimeline: (projectSlug: string, q: { range?: QueryRange } & RequestWindow & RequestLogFilters, o: Authed) =>
      request<RequestTimeline>("GET", "/requests/timeline", { ...o, query: { project: projectSlug, ...q } }),
    getRequest: (projectSlug: string, id: string, o: Authed) =>
      request<RequestDetailRead>("GET", `/requests/${seg(id)}`, { ...o, query: { project: projectSlug } }),
    trafficSummary: (projectSlug: string, q: QueryRange | TrafficQuery, o: Authed) =>
      request<TrafficSummary>("GET", "/traffic/summary", { ...o, query: { project: projectSlug, ...trafficScope(q) } }),
    trafficTimeseries: (projectSlug: string, q: TrafficQuery, o: Authed) =>
      request<TrafficTimeseries>("GET", "/traffic/timeseries", { ...o, query: { project: projectSlug, ...trafficScope(q) } }),
    listEndpoints: (projectSlug: string, q: TrafficQuery & { limit?: number }, o: Authed) =>
      request<{ endpoints: EndpointTraffic[] | null }>("GET", "/traffic/endpoints", {
        ...o,
        query: { project: projectSlug, ...trafficScope(q), ...(q.limit !== undefined ? { limit: q.limit } : {}) },
      }),
    deployChanges: (projectSlug: string, q: { range?: QueryRange; limit?: number }, o: Authed) =>
      request<DeployChanges>("GET", "/deploys/changes", { ...o, query: { project: projectSlug, ...q } }),
    listConsumers: (projectSlug: string, q: { range?: QueryRange; group?: string; limit?: number }, o: Authed) =>
      request<ConsumersList>("GET", "/consumers", { ...o, query: { project: projectSlug, ...q } }),
    getConsumer: (projectSlug: string, consumerId: string, q: { range?: QueryRange }, o: Authed) =>
      request<ConsumerDetail>("GET", `/consumers/${seg(consumerId)}`, { ...o, query: { project: projectSlug, ...q } }),

    // api: consumer groups (#580) ----------------------------------------------------------
    listConsumerGroups: (projectSlug: string, o: Authed) =>
      request<{ groups: ConsumerGroup[] | null }>("GET", `/projects/${seg(projectSlug)}/consumer-groups`, o),
    createConsumerGroup: (projectSlug: string, name: string, o: Authed) =>
      request<ConsumerGroup>("POST", `/projects/${seg(projectSlug)}/consumer-groups`, { ...o, body: { name } }),
    renameConsumerGroup: (projectSlug: string, id: string, name: string, o: Authed) =>
      request<ConsumerGroup>("PUT", `/projects/${seg(projectSlug)}/consumer-groups/${seg(id)}`, { ...o, body: { name } }),
    deleteConsumerGroup: (projectSlug: string, id: string, o: Authed) =>
      request<void>("DELETE", `/projects/${seg(projectSlug)}/consumer-groups/${seg(id)}`, o),
    assignConsumerGroup: (projectSlug: string, consumerId: string, groupId: string, o: Authed) =>
      request<{ consumer_id: string; group: ConsumerGroupRef; assigned_at: string }>(
        "PUT",
        `/projects/${seg(projectSlug)}/consumers/${seg(consumerId)}/group`,
        { ...o, body: { group_id: groupId } },
      ),
    unassignConsumerGroup: (projectSlug: string, consumerId: string, o: Authed) =>
      request<void>("DELETE", `/projects/${seg(projectSlug)}/consumers/${seg(consumerId)}/group`, o),

    projectApps: (projectSlug: string, o: Authed) =>
      request<ProjectApps>("GET", "/project", { ...o, query: { project: projectSlug } }),

    // api: app capture policy (#566) and SDK metadata (#598) -------------------------------
    getCapturePolicy: (appId: string, o: Authed) =>
      request<CapturePolicy>("GET", `/apps/${seg(appId)}/capture-policy`, o),
    putCapturePolicy: (appId: string, body: PutCapturePolicyRequest, o: Authed) =>
      request<CapturePolicy>("PUT", `/apps/${seg(appId)}/capture-policy`, { ...o, body }),
    appReports: (appId: string, o: Authed) => request<AppReports>("GET", `/apps/${seg(appId)}/metadata`, o),

    // query: ingest health of an app (#569, #582), read by the ingest health panel (#602) ----
    appIngestStats: (projectSlug: string, appId: string, days: number, o: Authed) =>
      request<AppIngestStats>("GET", `/apps/${seg(appId)}/ingest-stats`, { ...o, query: { project: projectSlug, days } }),
    appHealthStatus: (projectSlug: string, appId: string, o: Authed) =>
      request<AppHealthStatus>("GET", `/apps/${seg(appId)}/status`, { ...o, query: { project: projectSlug } }),

    // query: one endpoint's detail tabs (#571, #572, #573) and its settings (#593) ------------
    endpointRequests: (projectSlug: string, method: string, path: string, q: EndpointQuery, o: Authed) =>
      request<EndpointRequests>("GET", `/endpoints/${seg(method)}/${seg(path)}/requests`, { ...o, query: { project: projectSlug, ...endpointScope(q) } }),
    endpointErrors: (projectSlug: string, method: string, path: string, q: Omit<EndpointQuery, "status">, o: Authed) =>
      request<EndpointErrors>("GET", `/endpoints/${seg(method)}/${seg(path)}/errors`, { ...o, query: { project: projectSlug, ...endpointScope(q) } }),
    endpointLatency: (projectSlug: string, method: string, path: string, q: EndpointQuery, o: Authed) =>
      request<EndpointLatency>("GET", `/endpoints/${seg(method)}/${seg(path)}/latency`, { ...o, query: { project: projectSlug, ...endpointScope(q) } }),
    endpointTransfer: (projectSlug: string, method: string, path: string, q: EndpointQuery, o: Authed) =>
      request<EndpointTransfer>("GET", `/endpoints/${seg(method)}/${seg(path)}/transfer`, { ...o, query: { project: projectSlug, ...endpointScope(q) } }),
    getEndpointSettings: (projectSlug: string, appId: string, method: string, path: string, o: Authed) =>
      request<EndpointSettings>("GET", `/apps/${seg(appId)}/endpoints/${seg(method)}/${seg(path)}/settings`, { ...o, query: { project: projectSlug } }),
    putEndpointSettings: (appId: string, method: string, path: string, body: PutEndpointSettingsRequest, o: Authed) =>
      request<EndpointSettings>("PUT", `/apps/${seg(appId)}/endpoints/${seg(method)}/${seg(path)}/settings`, { ...o, body }),

    // query: the Errors dashboard (#581), read by the Errors page (#594) ---------------------
    errorStatuses: (projectSlug: string, q: TrafficQuery, o: Authed) =>
      request<ErrorStatuses>("GET", "/errors/status", { ...o, query: { project: projectSlug, ...trafficScope(q) } }),
    errorStatus: (projectSlug: string, code: number, q: TrafficQuery, o: Authed) =>
      request<ErrorStatusDetail>("GET", `/errors/status/${seg(String(code))}`, { ...o, query: { project: projectSlug, ...trafficScope(q) } }),
    listErrors: (projectSlug: string, q: TrafficQuery, o: Authed) =>
      request<{ errors: ErrorGroup[] | null }>("GET", "/errors", { ...o, query: { project: projectSlug, ...trafficScope(q) } }),

    // query: the Performance page (#595) ---------------------------------------------------
    trafficLatency: (projectSlug: string, q: TrafficQuery, o: Authed) =>
      request<TrafficLatency>("GET", "/traffic/latency", { ...o, query: { project: projectSlug, ...trafficScope(q) } }),
    getAppSettings: (projectSlug: string, appId: string, o: Authed) =>
      request<AppSettings>("GET", `/apps/${seg(appId)}/settings`, { ...o, query: { project: projectSlug } }),
    putAppSettings: (appId: string, body: { latency_threshold_ms: number | null }, o: Authed) =>
      request<AppSettings>("PUT", `/apps/${seg(appId)}/settings`, { ...o, body }),

    // api: project privacy policy (#562, #599) -------------------------------------------
    getPrivacyPolicy: (projectSlug: string, o: Authed) =>
      request<PrivacyPolicy>("GET", `/projects/${seg(projectSlug)}/privacy-policy`, o),
    putPrivacyPolicy: (projectSlug: string, body: PutPrivacyPolicyRequest, o: Authed) =>
      request<PrivacyPolicy>("PUT", `/projects/${seg(projectSlug)}/privacy-policy`, { ...o, body }),

    // api: project API keys ---------------------------------------------------------------
    listApiKeys: (projectSlug: string, o: Authed) =>
      request<ApiKey[]>("GET", `/projects/${seg(projectSlug)}/api-keys`, o),
    createApiKey: (projectSlug: string, body: CreateApiKeyRequest, o: Authed) =>
      request<CreatedApiKey>("POST", `/projects/${seg(projectSlug)}/api-keys`, { ...o, body }),
    revokeApiKey: (projectSlug: string, id: string, o: Authed) =>
      request<void>("DELETE", `/projects/${seg(projectSlug)}/api-keys/${seg(id)}`, o),
  };
}

export type IdentityClient = ReturnType<typeof createClient>;

let shared: IdentityClient | undefined;

/** The app-wide client, configured from `APILENS_API_URL` on first use. */
export function identity(): IdentityClient {
  shared ??= createClient({ baseUrl: env().apiUrl });
  return shared;
}
