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
  for (const key of ["type", "title", "detail", "instance", "code"] as const) {
    if (typeof body[key] === "string") p[key] = body[key] as string;
  }
  if (typeof body.status === "number") p.status = body.status;
  if (typeof body.retry_after === "number" && Number.isFinite(body.retry_after)) {
    p.retry_after = Math.max(0, Math.ceil(body.retry_after));
  }
  if (Array.isArray(body.errors)) p.errors = body.errors.filter(isRecord) as Problem["errors"];
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

type Method = "GET" | "POST" | "PATCH" | "DELETE";
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
    opts: CallOptions & { body?: unknown; query?: Query } = {},
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

export interface OnboardingState {
  step: string | null;
  completed: boolean;
  answers?: Record<string, unknown>;
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

export interface InvitationAccepted {
  org: OrgRef;
  role: OrgRole;
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

// ---------------------------------------------------------------------------------------------
// Operations

/**
 * The typed client. Paths are relative to `/api/v1`. Each operation takes an optional
 * {@link CallOptions} last; authenticated ones require `accessToken`.
 */
export function createClient(config: ClientConfig) {
  const request = makeRequest(config);
  type Authed = CallOptions & { accessToken: string };

  return {
    // identity: sign-in -------------------------------------------------------------------
    providers: (o?: CallOptions) => request<AuthProviders>("GET", "/auth/providers", o),
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

    // identity: sessions ------------------------------------------------------------------
    refresh: (body: { refresh_token: string }, o?: CallOptions) =>
      request<SessionBundle>("POST", "/auth/refresh", { ...o, body }),
    logout: (body: { refresh_token: string }, o?: CallOptions) =>
      request<void>("POST", "/auth/logout", { ...o, body }),

    // identity / api: current user --------------------------------------------------------
    me: (o: Authed) => request<User>("GET", "/users/me", o),
    context: (o: Authed) => request<UserContext>("GET", "/users/me/context", o),

    // identity: the signed-in user's sessions ---------------------------------------------
    listSessions: (o: Authed) => request<{ sessions: SessionInfo[] }>("GET", "/users/me/sessions", o),
    revokeSession: (id: string, o: Authed) => request<void>("DELETE", `/users/me/sessions/${seg(id)}`, o),
    revokeOtherSessions: (o: Authed) =>
      request<{ revoked: number }>("POST", "/users/me/sessions/revoke-others", o),

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
