// A fake identity server plus a fake OAuth provider and a fake OIDC identity provider for the
// social sign-in (#317), two-factor step (#320), organization SSO (#323), account settings (#339),
// profile (#340), sessions (#343), connected accounts (#344), Security → Passkeys (#341),
// two-factor settings (#342), organization members (#345), invitations (#346) and project API keys (#350)
// browser tests.
// It mirrors the real contract (internal/identity/oauth.go, oauth_callback.go, handoff_redeem.go):
//
//   GET  /api/v1/auth/providers                    google and github enabled
//   GET  /api/v1/auth/oauth/{provider}/start       checks `next`, keeps a state, 302 to the provider;
//                                                  intent=link needs a Bearer token
//   GET  /fake-provider/authorize                  consent page: "Authorize", "Use a taken account" or "Deny"
//   GET  /api/v1/auth/oauth/{provider}/callback    302 to {ui}/auth/callback?code=… or /sign-in?error=…;
//                                                  intent=link: 302 to {ui}{next}?linked=… (or error=oauth_identity_taken)
//   GET  /api/v1/users/me/identities               the connected accounts
//   DELETE /api/v1/users/me/identities/{id}        204, or 410 oauth_identity_gone
//   POST /api/v1/auth/handoff                      redeems a one-time code (session bundle or 2fa_required)
//   POST /api/v1/auth/2fa/exchange                 spends a pre-auth token with a TOTP or backup code
//   POST /api/v1/auth/logout                       204
//   GET  /api/v1/users/me/context                  one org (acme) with one project (shop); the
//                                                  role and capabilities follow the fake user's role,
//                                                  or the `capabilities` seeded for them
//   GET  /api/v1/users/me/sessions                 the signed-in user's sessions: this one + two seeded
//   DELETE /api/v1/users/me/sessions/{id}          204 (also for an unknown id)
//   POST /api/v1/users/me/sessions/revoke-others   {revoked}
//   POST /api/v1/auth/passkeys/register/options    creation options for the signed-in user
//   POST /api/v1/auth/passkeys/register/verify     checks clientDataJSON (type, challenge, origin) and
//                                                  stores the passkey; no attestation crypto
//   GET|PATCH|DELETE /api/v1/users/me/passkeys[/{id}]
//                                                  list, rename, remove the signed-in user's passkeys
//   GET  /api/v1/auth/2fa/status                   two-factor settings (#342), per access token:
//   POST /api/v1/auth/2fa/enable                   enable, verify, disable and regenerate as in
//   POST /api/v1/auth/2fa/verify                   internal/identity/twofactor.go
//   POST /api/v1/auth/2fa/disable
//   POST /api/v1/auth/2fa/backup-codes/regenerate
//   GET|PATCH /api/v1/users/me                     the fake user; PATCH renames it and saves
//                                                  preferences.home per user (#328)
//   PATCH /api/v1/users/me/onboarding              saves the step, completed and merges the answers per user (#327);
//                                                  the context reports them. An org_slug of
//                                                  `unavailable` answers 503 unavailable
//   GET  /api/v1/orgs/slug-available?slug=         acme, beta, globex, admin, apilens and created slugs are
//                                                  taken (with free suggestions); `race-lost` is available
//   POST /api/v1/orgs                              creates an org the user owns (in their context);
//                                                  slug_taken + suggestions for taken slugs and `race-lost` (#330)
//   GET  /api/v1/projects/slug-available?slug=     shop, storefront, admin and created project slugs are
//                                                  taken (with free suggestions); `race-lost` is available
//   POST /api/v1/orgs/{slug}/projects              creates a project in an org the user belongs to (in their
//                                                  context; viewers 403); slug_taken as for orgs (#331)
//   POST /api/v1/users/me/email/change            `taken@example.com` answers email_taken
//   POST /api/v1/users/me/email/confirm            code 123456 moves the email, anything else invalid_code
//   DELETE /api/v1/users/me                        owner_transfer_required while the user is acme's only owner
//   POST /__fake/profile {name?, email?, sole_owner?}
//                                                  test hook: resets the fake user's profile state
//   GET  /api/v1/auth/sso/lookup?email=            acme.example.com: Acme, enforced;
//                                                  beta.example.com: Beta, not enforced; else none
//   GET  /api/v1/auth/sso/{org}/start              keeps a state, 302 to the fake IdP's authorize
//   GET  /fake-idp/authorize                       IdP sign-in page: "Sign in" or "Cancel"
//   GET  /api/v1/auth/sso/{org}/callback           302 to {ui}/auth/callback?code=… or /sign-in?error=…
//   POST /api/v1/auth/email/start                  403 sso_required (+ start_url) on an enforced
//                                                  domain, else {sent: true} (never sends mail)
//   GET  /api/v1/orgs/acme/members                 the signed-in user plus seeded @example.com members
//   PATCH/DELETE /api/v1/orgs/acme/members/{id}    role change / removal with the API's owner rules
//   POST /api/v1/orgs/acme/transfer-ownership      owners only; the caller becomes an admin
//   GET  /api/v1/orgs/acme/invitations             pending invitations (three seeded per user), newest first
//   POST /api/v1/orgs/acme/invitations             records each new address, answers one result per address;
//                                                  also on orgs the user created in onboarding (#336), where
//                                                  they are the only member; down@example.com answers 503
//   POST /api/v1/orgs/acme/invitations/{id}/resend 5-minute cooldown (429 rate_limited + retry_after)
//   DELETE /api/v1/orgs/acme/invitations/{id}      revoke; 410 invite_expired when already gone
//   GET|PUT|DELETE /api/v1/orgs/acme/sso           the signed-in user's own SSO connection (#348),
//                                                  owners only; enforce needs `last_login_at` (sso_untested)
//   POST /api/v1/orgs/acme/sso/test                discovery: an issuer containing "broken" is
//                                                  unreachable, any other one answers its endpoints
//   GET|POST /api/v1/projects/shop/api-keys        list (newest first), create (raw key once); also
//                                                  on projects the user created in onboarding (#333);
//   DELETE /api/v1/projects/shop/api-keys/{id}     revoke (204, or 410 api_key_gone). Creating and
//                                                  revoking answer 403 without the capability
//   GET  /api/v1/projects/{slug}/ingest-status     {received, first_at, last_at, count_1h} of shop or a
//                                                  project the user created (#334); 403 otherwise
//   POST /v1/requests                              the ingest edge's v1 endpoint (#334): an X-API-Key
//                                                  created here records the requests on its project
//                                                  ({accepted}); anything else answers 401
//   GET  /api/v1/requests?project=                 query reads as the session (#335): the rows the fake
//   GET  /api/v1/traffic/summary?project=          edge stored for shop or a project the user created,
//   GET  /api/v1/traffic/endpoints?project=        newest first, and totals/p95 over them; 404 otherwise
//   GET  /api/v1/deploys/changes?project=          deploys with before/after numbers (#597), as seeded
//   POST /__fake/deploys {project, deploys}        test hook: what that answers for `project`
//   POST /__fake/query-down {project, down}        test hook: those reads answer 503 for `project`
//   GET  /api/v1/project?project=shop              shop's apps (#598): one app `shop` unless seeded
//   GET|PUT /api/v1/apps/{id}/capture-policy       the app's capture policy (#598): everything captured
//                                                  until saved; PUT answers 403 without capture.manage
//   GET  /api/v1/apps/{id}/metadata                what the app's SDKs reported, per environment (#598)
//   POST /__fake/apps {apps}                       test hook: replaces shop's apps [{id, slug, name,
//                                                  policy?, environments?}], their policies and reports
//   GET|PUT /api/v1/projects/shop/privacy-policy   shop's server-side deny list (#599): only the defaults
//                                                  until saved; PUT answers 403 without project.update and
//                                                  invalid_request naming a pattern JavaScript cannot compile
//   POST /__fake/privacy {}                        test hook: forgets shop's saved deny list
//   POST /__fake/handoff {next, role?, totp_secret?, backup_codes?, passkeys?, capabilities?, api_keys?, sso?, stale?}
//                                                  test hook: a code whose bundle carries any `next`;
//                                                  `role` is the user's role in acme (default owner);
//                                                  with `totp_secret` (base32) it answers 2fa_required;
//                                                  `passkeys` seeds the new user's passkey list,
//                                                  `capabilities` their actions on shop, `api_keys`
//                                                  shop's keys as that user sees them;
//                                                  `sso` seeds acme's SSO connection (fields of the read),
//                                                  `stale` makes /2fa/enable answer reauth_required;
//                                                  `joinable` [{slug, name, member_initials?, member_count?,
//                                                  projects?: [slug]}] seeds the orgs they may join (#329)
//   POST /__fake/identities {identities}          test hook: replaces the connected accounts
//   GET  /api/v1/auth/invitations/{token}          invitation landing (#337): inv_globex (for
//                                                  you@example.com), inv_other (another address),
//                                                  inv_expired (invite_expired); else invalid_token
//   POST /api/v1/auth/invitations/{token}/accept   joins globex (project storefront) as a member;
//                                                  invite_email_mismatch for inv_other
//   GET  /api/v1/users/me/joinable-orgs            the organizations seeded as `joinable` for the user (#329),
//                                                  minus those joined; none unless seeded
//   POST /api/v1/orgs/{slug}/join                  joins a seeded joinable org as a member (it then shows in
//                                                  the context with its projects); 403 forbidden otherwise
//
// Nothing here sends mail or talks to a real provider. Run with
// `node --experimental-strip-types e2e-fake/fake-identity.ts` (Playwright starts it).
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";

const PORT = Number(process.env.FAKE_IDENTITY_PORT ?? 18080);
const UI_URL = (process.env.FAKE_IDENTITY_UI_URL ?? "http://localhost:3210").replace(/\/+$/, "");
const SELF = `http://localhost:${PORT}`;
const PROVIDERS = new Set(["google", "github"]);

/** Organizations with an SSO connection, by email domain (internal/identity/sso_lookup.go). */
const SSO_ORGS: Record<string, { slug: string; name: string; enforce: boolean }> = {
  "acme.example.com": { slug: "acme", name: "Acme", enforce: true },
  "beta.example.com": { slug: "beta", name: "Beta", enforce: false },
};
const ssoStartUrl = (slug: string) => `${SELF}/api/v1/auth/sso/${encodeURIComponent(slug)}/start`;
const ssoOrgFor = (email: string) => SSO_ORGS[email.trim().toLowerCase().split("@")[1] ?? ""];

interface SSOState {
  org: string;
  next: string;
  loginHint: string;
}
const ssoStates = new Map<string, SSOState>();

interface State {
  provider: string;
  next: string;
  remember: boolean;
  intent: "login" | "link";
}

interface Identity {
  id: string;
  provider: string;
  email: string | null;
  name: string;
  username: string;
  avatar_url: string;
  created_at: string;
  last_login_at: string | null;
}

/** The connected accounts of every fake user (tests run one at a time). */
let identities: Identity[] = [];

interface PreAuth {
  secret: Buffer;
  backupCodes: Set<string>;
  next: string;
  attempts: number;
}

/** Two-factor settings of one signed-in fake user, keyed by their access token. */
interface Totp {
  pending: Buffer | null;
  secret: Buffer | null;
  confirmedAt: string | null;
  backupCodes: Set<string>;
  /** The sign-in is "too old" for enabling (identity's 10-minute reauth window). */
  stale: boolean;
}

const states = new Map<string, State>();
const totps = new Map<string, Totp>();
const handoffs = new Map<string, unknown>();
const preAuths = new Map<string, PreAuth>();
const token = () => randomBytes(24).toString("base64url");

/** Mirrors identity.PreAuthMaxAttempts. */
const PRE_AUTH_MAX_ATTEMPTS = 5;

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of input.toUpperCase().replace(/=+$/, "")) {
    const i = alphabet.indexOf(ch);
    if (i < 0) throw new Error("bad base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s), like internal/identity/twofactor. */
function totp(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", secret).update(counter).digest();
  const off = mac[mac.length - 1] & 0x0f;
  const n = (mac.readUInt32BE(off) & 0x7fffffff) % 1_000_000;
  return String(n).padStart(6, "0");
}

/** Accepts the current step and one either side, as identity does. */
function totpValid(secret: Buffer, code: string): boolean {
  const step = Math.floor(Date.now() / 30_000);
  return [-1, 0, 1].some((d) => totp(secret, step + d) === code);
}

const normalizeBackup = (code: string) => code.toLowerCase().replace(/[-\s]/g, "");

function base32Encode(buf: Buffer): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

/** Ten xxxx-xxxx codes over lowercase base32, like twofactor.NewBackupCodes. */
function newBackupCodes(): string[] {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  return Array.from({ length: 10 }, () => {
    const raw = [...randomBytes(8)].map((b) => alphabet[b & 31]).join("");
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
}

/** Same rules as identity.SafeNext: "" means "/", else one leading "/" and no backslash/control. */
function safeNext(next: string): string | null {
  if (next === "") return "/";
  if (next.length > 2048 || !next.startsWith("/") || next.startsWith("//")) return null;
  for (const ch of next) {
    const c = ch.charCodeAt(0);
    if (c < 0x20 || c === 0x7f || ch === "\\") return null;
  }
  return next;
}

interface FakeSession {
  id: string;
  /** The access token of the browser holding this session; null for the seeded other devices. */
  access: string | null;
  device_label: string;
  user_agent: string;
  ip: string | null;
  amr: string[];
  created_at: string;
  last_seen_at: string;
  expires_at: string;
}

/** Sessions per fake user, and the user each access token belongs to. */
const sessionsByUser = new Map<string, FakeSession[]>();
const userByAccess = new Map<string, string>();

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/** A new user signed in on this browser plus two older devices (documentation IPs). */
function seedSessions(user: string, access: string) {
  const expires = new Date(Date.now() + 30 * 24 * 3600_000).toISOString();
  const s = (holder: string | null, device: string, ip: string | null, amr: string[], created: number, seen: number): FakeSession => ({
    id: randomUUID(),
    access: holder,
    device_label: device,
    user_agent: `${device} (fake)`,
    ip,
    amr,
    created_at: ago(created),
    last_seen_at: ago(seen),
    expires_at: expires,
  });
  sessionsByUser.set(user, [
    s(null, "Firefox on Windows", "198.51.100.23", ["google"], 9 * 24 * 60, 3 * 24 * 60),
    s(access, "Chrome on macOS", "203.0.113.7", ["email"], 0, 0),
    s(null, "Safari on iOS", null, ["passkey", "totp"], 2 * 24 * 60, 45),
  ]);
  userByAccess.set(access, user);
}

/** A stored passkey, as `GET /users/me/passkeys` lists it, plus its credential id. */
interface FakePasskey {
  id: string;
  credential_id: string;
  name: string;
  aaguid: string;
  authenticator: string;
  transports: string[];
  backup_eligible: boolean;
  backup_state: boolean;
  created_at: string;
  last_used_at: string | null;
}

/** User id → passkeys, oldest first. */
const passkeys = new Map<string, FakePasskey[]>();
/** Registration challenges: challenge id → user and challenge (once, like identity). */
const registrations = new Map<string, { user: string; challenge: string }>();
const ZERO_AAGUID = "00000000-0000-0000-0000-000000000000";

const listed = ({ credential_id: _, ...p }: FakePasskey) => p;

function seedPasskey(input: Record<string, unknown>): FakePasskey {
  return {
    id: randomUUID(),
    credential_id: token(),
    name: String(input.name ?? "Passkey"),
    aaguid: ZERO_AAGUID,
    authenticator: String(input.authenticator ?? ""),
    transports: Array.isArray(input.transports) ? input.transports.map(String) : ["internal"],
    backup_eligible: input.backup_state === true,
    backup_state: input.backup_state === true,
    created_at: String(input.created_at ?? new Date().toISOString()),
    last_used_at: typeof input.last_used_at === "string" ? input.last_used_at : null,
  };
}

type Role = "owner" | "admin" | "member" | "viewer";
const ROLES = new Set<Role>(["owner", "admin", "member", "viewer"]);

interface FakeMember {
  user: { id: string; email: string; name: string; avatar_url: string };
  role: Role;
  joined_at: string;
  last_login_at: string | null;
}

/** Each fake user's own copy of the acme organization's members, so tests never share state. */
const membersByUser = new Map<string, FakeMember[]>();

/** The signed-in user plus one seeded member per role (no second owner when they are the owner). */
function seedMembers(id: string, role: Role) {
  const m = (uid: string, name: string, email: string, r: Role, days: number): FakeMember => ({
    user: { id: uid, email, name, avatar_url: "" },
    role: r,
    joined_at: ago(days * 24 * 60),
    last_login_at: null,
  });
  const others = [
    m(randomUUID(), "Olive Owner", "olive@example.com", "owner", 60),
    m(randomUUID(), "Ada Admin", "ada@example.com", "admin", 20),
    m(randomUUID(), "Max Member", "max@example.com", "member", 10),
    m(randomUUID(), "Vera Viewer", "vera@example.com", "viewer", 2),
  ].filter((o) => !(role === "owner" && o.role === "owner"));
  const all = [m(id, "Fake User", "you@example.com", role, 30), ...others];
  membersByUser.set(id, all.sort((a, b) => a.joined_at.localeCompare(b.joined_at)));
}

interface FakeInvitation {
  id: string;
  email: string;
  role: Exclude<Role, "owner">;
  created_at: string;
  expires_at: string;
  resent_at: string | null;
  invited_by?: { id: string; email: string; name: string };
}

/** Each fake user's own pending invitations to acme. */
const invitationsByUser = new Map<string, FakeInvitation[]>();
const INVITE_TTL_MS = 7 * 24 * 3600_000;
const RESEND_COOLDOWN_MS = 5 * 60_000;

/** Three pending invitations: one just sent (in its cooldown), one from days ago, one expired. */
function seedInvitations(id: string) {
  const me = { id, email: "you@example.com", name: "Fake User" };
  const inv = (email: string, role: FakeInvitation["role"], minutes: number, by?: FakeInvitation["invited_by"]): FakeInvitation => ({
    id: randomUUID(),
    email,
    role,
    created_at: ago(minutes),
    expires_at: new Date(Date.now() - minutes * 60_000 + INVITE_TTL_MS).toISOString(),
    resent_at: null,
    invited_by: by,
  });
  invitationsByUser.set(id, [
    inv("new.hire@example.com", "member", 1, me),
    inv("grace@example.com", "admin", 2 * 24 * 60, { id: randomUUID(), email: "ada@example.com", name: "Ada Admin" }),
    inv("late@example.com", "viewer", 8 * 24 * 60),
  ]);
}

/** The user's current role in acme (it changes on a transfer). */
const roleOf = (id: string): Role => membersByUser.get(id)?.find((m) => m.user.id === id)?.role ?? "owner";

/** What `users/me/context` lists for the shop project, as SpiceDB would answer for `role`. */
function capabilitiesFor(role: Role): string[] {
  const all = ["project.read", "project.update", "project.delete", "api_keys.create", "api_keys.revoke", "capture.manage", "members.invite", "members.remove", "billing.manage"];
  if (role === "owner") return all;
  if (role === "admin") return all.filter((a) => a !== "project.delete" && a !== "billing.manage");
  if (role === "member") return ["project.read", "project.update", "api_keys.create", "api_keys.revoke"];
  return ["project.read"];
}

/** A project API key as `GET /projects/{slug}/api-keys` lists it. */
interface FakeApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

/** The one project of the fake context. */
const PROJECT = "shop";
/** User id → their seeded actions on shop (absent: what their role allows). */
const capabilities = new Map<string, string[]>();
/** User id → shop's API keys as that user sees them, newest first. */
const apiKeys = new Map<string, FakeApiKey[]>();

/** Raw key → the project it was created on and its id, for the fake ingest edge (#334). */
const rawKeys = new Map<string, { project: string; id: string; user: string }>();
/** Project slug → what the fake edge stored for it: `ingest-status` reads it (#334). */
const ingested = new Map<string, { first_at: string; last_at: string; count: number }>();
/** Project slug → the request rows the fake edge stored, newest first: the query reads serve them (#335). */
const ingestedRows = new Map<
  string,
  {
    timestamp: string;
    method: string;
    path: string;
    raw_path: string;
    status_code: number;
    response_time_ms: number;
    environment: string;
    consumer_id: string;
    consumer_name: string;
    trace_id: string;
  }[]
>();
/** Projects whose query reads answer 503, set by `/__fake/query-down` (#335). */
const queryDown = new Set<string>();
/** Project slug → the deploys `GET /deploys/changes` answers, as seeded by `/__fake/deploys` (#597). */
const deployChanges = new Map<string, Record<string, unknown>[]>();

/** shop's apps (#598), their saved capture policies and what their SDKs reported, by app id. */
const DEFAULT_APP = { id: "5d0c1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d", slug: PROJECT, name: "Shop" };
let shopApps: { id: string; slug: string; name: string }[] = [DEFAULT_APP];
const capturePolicies = new Map<string, Record<string, unknown>>();
const appReports = new Map<string, Record<string, unknown>[]>();

function capturePolicyOf(app: { id: string; slug: string }): Record<string, unknown> {
  return {
    app_id: app.id,
    app: app.slug,
    project: PROJECT,
    enabled: true,
    sample_rate: 1,
    capture_headers: true,
    capture_request_body: true,
    capture_response_body: true,
    max_payload_bytes: null,
    updated_at: null,
    updated_by: null,
    ...capturePolicies.get(app.id),
  };
}

/** shop's saved deny list (#599); null until saved. */
let privacyPolicy: { mask_query_params: string[]; mask_headers: string[]; mask_body_fields: string[]; updated_at: string } | null = null;

function privacyPolicyOf(): Record<string, unknown> {
  return {
    app: null,
    mask_query_params: privacyPolicy?.mask_query_params ?? [],
    mask_headers: privacyPolicy?.mask_headers ?? [],
    mask_body_fields: privacyPolicy?.mask_body_fields ?? [],
    defaults: {
      mask_query_params: ["auth", "api.?key", "secret", "token", "password", "pwd"],
      mask_headers: ["auth", "api.?key", "secret", "token", "cookie"],
      sensitive_headers: ["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key", "api-key", "x-auth-token", "x-amz-security-token", "x-csrf-token"],
      mask_body_fields: ["password", "pwd", "token", "secret", "auth", "card.?number", "ccv", "cvv", "cvc", "ssn"],
    },
    updated_at: privacyPolicy?.updated_at ?? null,
  };
}

function seedApiKey(input: Record<string, unknown>): FakeApiKey {
  return {
    id: randomUUID(),
    name: String(input.name ?? "Key"),
    prefix: String(input.prefix ?? `apl_live_${token().slice(0, 7)}`),
    scopes: Array.isArray(input.scopes) ? input.scopes.map(String) : ["ingest"],
    created_at: String(input.created_at ?? new Date().toISOString()),
    expires_at: typeof input.expires_at === "string" ? input.expires_at : null,
    last_used_at: typeof input.last_used_at === "string" ? input.last_used_at : null,
    revoked_at: typeof input.revoked_at === "string" ? input.revoked_at : null,
  };
}

interface Seeds {
  passkeys?: Record<string, unknown>[];
  capabilities?: string[];
  apiKeys?: Record<string, unknown>[];
  sso?: Record<string, unknown>;
  joinable?: Record<string, unknown>[];
}

/** An organization a fake user may join by verified email domain (#329). */
interface FakeJoinable {
  id: string;
  slug: string;
  name: string;
  member_count: number;
  member_initials: string[];
  projects: string[];
}
/** User id → the organizations they may join; user id → the slugs they joined. */
const joinableByUser = new Map<string, FakeJoinable[]>();
const joinedByUser = new Map<string, Set<string>>();

function seedJoinable(input: Record<string, unknown>): FakeJoinable {
  const slug = String(input.slug);
  return {
    id: `org_${slug}`,
    slug,
    name: String(input.name ?? slug),
    member_count: Number(input.member_count ?? 3),
    member_initials: Array.isArray(input.member_initials) ? input.member_initials.map(String) : [],
    projects: Array.isArray(input.projects) ? input.projects.map(String) : [],
  };
}

/** The organizations `id` joined by domain, as the context lists them. */
function joinedOrgs(id: string) {
  const joined = joinedByUser.get(id) ?? new Set<string>();
  return (joinableByUser.get(id) ?? [])
    .filter((o) => joined.has(o.slug))
    .map((o) => ({
      id: o.id,
      slug: o.slug,
      name: o.name,
      role: "member",
      projects: o.projects.map((p) => ({ id: `prj_${p}`, slug: p, name: p, environments: ["production"] })),
    }));
}

/** User id → acme's SSO connection as that user sees it (absent: none configured). */
const ssoByUser = new Map<string, Record<string, unknown>>();

function ssoConnection(fields: Record<string, unknown>): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    issuer: "https://idp.example.com",
    client_id: "apilens",
    domains: ["example.com"],
    enforce: false,
    default_role: "member",
    created_at: now,
    updated_at: now,
    last_login_at: null,
    ...fields,
    client_secret: "********",
    redirect_uri: `${SELF}/api/v1/auth/sso/acme/callback`,
    start_url: `${SELF}/api/v1/auth/sso/acme/start`,
  };
}

/** The user's actions on shop: seeded ones, else what their role allows. */
const capabilitiesOf = (id: string): string[] => capabilities.get(id) ?? capabilitiesFor(roleOf(id));

function bundle(next: string, seeds: Seeds = {}, role: Role = "owner") {
  const id = randomUUID();
  const access = `at_${token()}`;
  seedSessions(id, access);
  seedMembers(id, role);
  seedInvitations(id);
  passkeys.set(id, (seeds.passkeys ?? []).map(seedPasskey));
  if (seeds.capabilities) capabilities.set(id, seeds.capabilities);
  apiKeys.set(id, (seeds.apiKeys ?? []).map(seedApiKey));
  if (seeds.sso) ssoByUser.set(id, ssoConnection(seeds.sso));
  joinableByUser.set(id, (seeds.joinable ?? []).map(seedJoinable));
  return {
    access_token: access,
    refresh_token: `rt_${token()}`,
    expires_in: 900,
    user: {
      id,
      email: "you@example.com",
      email_verified: true,
      name: "Fake User",
      avatar_url: null,
      preferences: {},
      onboarding: { step: null, completed: false },
      created_at: new Date().toISOString(),
    },
    next,
  };
}

/** The fake user's profile (#340): what `PATCH /users/me` and the email change move. */
const PROFILE_DEFAULTS = { name: "Fake User", email: "you@example.com", soleOwner: true };
const profile = { ...PROFILE_DEFAULTS, pendingEmail: null as string | null };

/** Each fake user's saved onboarding progress (#327): the step, answers and whether it is done. */
const onboardingByUser = new Map<string, { step: string | null; completed: boolean; answers: Record<string, unknown> }>();
const onboardingOf = (id: string) => onboardingByUser.get(id) ?? { step: null, completed: false, answers: {} };
const ONBOARDING_ANSWERS: Record<string, RegExp | "count"> = {
  org_slug: /^([a-z0-9][a-z0-9-]{0,62})?$/,
  project_slug: /^([a-z0-9][a-z0-9-]{0,62})?$/,
  language: /^([a-z0-9][a-z0-9._+-]{0,31})?$/,
  runtime: /^([a-z0-9][a-z0-9._+-]{0,31})?$/,
  method: /^([a-z0-9][a-z0-9._+-]{0,31})?$/,
  invited: "count",
  api_key_id: /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/,
};

/** Invitations by token (#337); every address is @example.com. */
const INVITES: Record<string, { email: string; masked: string; expired?: boolean }> = {
  inv_globex: { email: "you@example.com", masked: "y***@example.com" },
  inv_other: { email: "someone@example.com", masked: "s***@example.com" },
  inv_expired: { email: "you@example.com", masked: "y***@example.com", expired: true },
};
/** The organization every fake invitation is to. */
const GLOBEX = {
  id: "org_globex",
  slug: "globex",
  name: "Globex",
  role: "member",
  projects: [{ id: "prj_globex", slug: "storefront", name: "storefront", environments: ["production"] }],
};
/** Users who accepted an invitation. */
const joinedGlobex = new Set<string>();

/** Each fake user's preferences (#328): the home screen picked in onboarding. */
const preferencesByUser = new Map<string, Record<string, unknown>>();
const preferencesOf = (id: string) => preferencesByUser.get(id) ?? {};
const HOME_SCREENS = new Set(["endpoints", "requests", "exceptions"]);
/** Organizations created through `POST /orgs` (#330), by slug; the creator owns each. */
const createdOrgs = new Map<string, { id: string; slug: string; name: string; role: string; owner: string }>();
const ORG_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** Slugs no new organization can use: the seeded organizations plus reserved words. */
const TAKEN_ORG_SLUGS = new Set(["acme", "beta", "globex", "admin", "apilens"]);
/** Answers available to the check but slug_taken to the create: someone took it in between. */
const RACE_SLUG = "race-lost";
const orgSlugTaken = (slug: string) => TAKEN_ORG_SLUGS.has(slug) || createdOrgs.has(slug) || slug === RACE_SLUG;
const orgSlugSuggestions = (slug: string) => [`${slug}-hq`, `${slug}-2`, `${slug}-team`].filter((s) => !orgSlugTaken(s));
/** Projects created through `POST /orgs/{slug}/projects` (#331), by slug. */
const createdProjects = new Map<string, { id: string; slug: string; name: string; environments: string[]; org: string; owner: string }>();
/** Slugs no new project can use: the seeded projects plus a reserved word. */
const TAKEN_PROJECT_SLUGS = new Set(["shop", "storefront", "admin"]);
const projectSlugTaken = (slug: string) => TAKEN_PROJECT_SLUGS.has(slug) || createdProjects.has(slug) || slug === RACE_SLUG;
const projectSlugSuggestions = (slug: string) => [`${slug}-api`, `${slug}-2`, `${slug}-app`].filter((s) => !projectSlugTaken(s));
const ENV_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** The projects user `id` created in organization `org`, as the context lists them. */
const createdProjectsOf = (id: string, org: string) =>
  [...createdProjects.values()]
    .filter((p) => p.owner === id && p.org === org)
    .map(({ id: pid, slug, name, environments }) => ({ id: pid, slug, name, environments }));
const createdOrgsOf = (id: string) =>
  [...createdOrgs.values()].filter((o) => o.owner === id).map(({ owner: _owner, ...o }) => ({ ...o, projects: createdProjectsOf(id, o.slug) }));

/** `GET /users/me/context` for a signed-in fake user: one org with one project (plus globex once invited). */
function context(id: string) {
  const role = roleOf(id);
  const progress = onboardingOf(id);
  return {
    user: {
      id,
      email: profile.email,
      email_verified: true,
      name: profile.name,
      avatar_url: null,
      preferences: preferencesOf(id),
      onboarding: { step: progress.step, completed: progress.completed, answers: progress.answers },
      created_at: new Date().toISOString(),
    },
    orgs: [
      {
        id: "org_fake",
        slug: "acme",
        name: "Acme",
        role,
        projects: [{ id: "prj_fake", slug: "shop", name: "shop", environments: ["production"] }, ...createdProjectsOf(id, "acme")],
      },
      ...(joinedGlobex.has(id) ? [GLOBEX] : []),
      ...createdOrgsOf(id),
      ...joinedOrgs(id),
    ],
    last_project_slug: "shop",
    // Every fake sign-in is a new user, so onboarding is still open: `/onboarding/*` shows (#326).
    onboarding: { step: progress.step, completed: progress.completed },
    capabilities: {
      [PROJECT]: capabilitiesOf(id),
      ...(joinedGlobex.has(id) ? { storefront: capabilitiesFor("member") } : {}),
      ...Object.fromEntries(joinedOrgs(id).flatMap((o) => o.projects.map((p) => [p.slug, capabilitiesFor("member")]))),
    },
  };
}

function issueHandoff(
  next: string,
  secret?: string,
  backupCodes: string[] = [],
  seeds: Seeds = {},
  stale = false,
  role: Role = "owner",
): string {
  const code = token();
  if (secret) {
    const pre = token();
    preAuths.set(pre, {
      secret: base32Decode(secret),
      backupCodes: new Set(backupCodes.map(normalizeBackup)),
      next,
      attempts: 0,
    });
    handoffs.set(code, { status: "2fa_required", pre_auth_token: pre, next });
  } else {
    const b = bundle(next, seeds, role);
    totps.set(b.access_token, { pending: null, secret: null, confirmedAt: null, backupCodes: new Set(), stale });
    handoffs.set(code, b);
  }
  return code;
}

/** The signed-in user's id, from `Authorization: Bearer at_…`. */
function signedInUser(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization ?? "";
  return auth.startsWith("Bearer ") ? userByAccess.get(auth.slice(7)) : undefined;
}

const b64u = (b: Buffer) => b.toString("base64url");

function send(res: ServerResponse, status: number, body?: unknown, type = "application/json") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body));
}

function problem(res: ServerResponse, status: number, code: string) {
  send(res, status, { status, title: code, code }, "application/problem+json");
}

function redirect(res: ServerResponse, location: string) {
  res.writeHead(302, { location, "cache-control": "no-store", "referrer-policy": "no-referrer" });
  res.end();
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", SELF);
  const path = url.pathname;
  const q = url.searchParams;

  if (req.method === "GET" && path === "/healthz") return send(res, 200, { ok: true });
  if (req.method === "GET" && path === "/api/v1/auth/providers") {
    return send(res, 200, { email: true, passkeys: true, google: true, github: true, sso: true });
  }

  if (req.method === "GET" && path === "/api/v1/auth/sso/lookup") {
    const org = ssoOrgFor(q.get("email") ?? "");
    if (!org) return send(res, 200, { sso: false, enforced: false });
    return send(res, 200, { sso: true, enforced: org.enforce, org_name: org.name, start_url: ssoStartUrl(org.slug) });
  }
  if (req.method === "POST" && path === "/api/v1/auth/email/start") {
    const { email } = await readBody(req);
    const org = ssoOrgFor(String(email ?? ""));
    if (org?.enforce) {
      return send(res, 403, { status: 403, title: "Forbidden", code: "sso_required", start_url: ssoStartUrl(org.slug) }, "application/problem+json");
    }
    return send(res, 200, { sent: true, retry_after: 30 });
  }

  const sso = path.match(/^\/api\/v1\/auth\/sso\/([a-z0-9-]+)\/(start|callback)$/);
  if (req.method === "GET" && sso) {
    const [, org, step] = sso;
    if (!Object.values(SSO_ORGS).some((o) => o.slug === org)) return problem(res, 404, "not_found");
    if (step === "start") {
      const next = safeNext(q.get("next") ?? "");
      if (next === null) return problem(res, 400, "invalid_request");
      const state = token();
      const loginHint = q.get("login_hint") ?? "";
      ssoStates.set(state, { org, next, loginHint });
      const authorize = new URLSearchParams({
        response_type: "code",
        client_id: `apilens-${org}`,
        redirect_uri: `${SELF}/api/v1/auth/sso/${org}/callback`,
        scope: "openid email profile",
        state,
        login_hint: loginHint,
      });
      return redirect(res, `${SELF}/fake-idp/authorize?${authorize}`);
    }
    const state = q.get("state") ?? "";
    const st = ssoStates.get(state);
    ssoStates.delete(state);
    if (!st || st.org !== org) return redirect(res, `${UI_URL}/sign-in?error=oauth_state_mismatch`);
    if (q.get("error")) return redirect(res, `${UI_URL}/sign-in?error=oauth_denied`);
    const code = issueHandoff(st.next === "/" ? "/onboarding/about" : st.next);
    return redirect(res, `${UI_URL}/auth/callback?${new URLSearchParams({ code })}`);
  }

  if (req.method === "GET" && path === "/fake-idp/authorize") {
    const back = q.get("redirect_uri") ?? "";
    const state = q.get("state") ?? "";
    if (!back.startsWith(`${SELF}/api/v1/auth/sso/`)) return problem(res, 400, "invalid_request");
    const allow = `${back}?${new URLSearchParams({ code: `idp_${token()}`, state })}`;
    const deny = `${back}?${new URLSearchParams({ error: "access_denied", state })}`;
    return send(
      res,
      200,
      `<!doctype html><title>Fake IdP</title><h1>Fake IdP sign-in</h1>` +
        `<p>Client <code>${escape(q.get("client_id") ?? "")}</code></p>` +
        `<p>Account <output id="login-hint">${escape(q.get("login_hint") ?? "")}</output></p>` +
        `<a href="${escape(allow)}">Sign in</a> <a href="${escape(deny)}">Cancel</a>`,
      "text/html; charset=utf-8",
    );
  }

  const oauth = path.match(/^\/api\/v1\/auth\/oauth\/([a-z]+)\/(start|callback)$/);
  if (req.method === "GET" && oauth) {
    const [, provider, step] = oauth;
    if (!PROVIDERS.has(provider)) return problem(res, 404, "not_found");
    if (step === "start") {
      const next = safeNext(q.get("next") ?? "");
      const intent = q.get("intent") ?? "login";
      if (next === null || (intent !== "login" && intent !== "link")) return problem(res, 400, "invalid_request");
      if (intent === "link" && !req.headers.authorization?.startsWith("Bearer at_")) return problem(res, 401, "unauthenticated");
      const state = token();
      states.set(state, { provider, next, remember: q.get("remember") === "true", intent });
      return redirect(res, `${SELF}/fake-provider/authorize?${new URLSearchParams({ provider, state })}`);
    }
    const state = q.get("state") ?? "";
    const st = states.get(state);
    states.delete(state);
    if (!st || st.provider !== provider) return redirect(res, `${UI_URL}/sign-in?error=oauth_state_mismatch`);
    if (q.get("error")) return redirect(res, `${UI_URL}/sign-in?error=oauth_denied`);
    if (st.intent === "link") {
      if ((q.get("code") ?? "").startsWith("taken_")) return redirect(res, `${UI_URL}/sign-in?error=oauth_identity_taken`);
      identities.push({
        id: randomUUID(),
        provider,
        email: "you@example.com",
        name: "Fake User",
        username: provider === "github" ? "fake-user" : "",
        avatar_url: "",
        created_at: new Date().toISOString(),
        last_login_at: null,
      });
      const back = new URL(st.next, UI_URL);
      back.searchParams.set("linked", provider);
      return redirect(res, back.href);
    }
    // Every fake sign-in is a new user: identity sends them to onboarding unless `next` says otherwise.
    const code = issueHandoff(st.next === "/" ? "/onboarding/about" : st.next);
    return redirect(res, `${UI_URL}/auth/callback?${new URLSearchParams({ code })}`);
  }

  if (req.method === "GET" && path === "/fake-provider/authorize") {
    const provider = q.get("provider") ?? "";
    const state = q.get("state") ?? "";
    const back = `${SELF}/api/v1/auth/oauth/${encodeURIComponent(provider)}/callback`;
    const allow = `${back}?${new URLSearchParams({ code: `prov_${token()}`, state })}`;
    const deny = `${back}?${new URLSearchParams({ error: "access_denied", state })}`;
    const taken = `${back}?${new URLSearchParams({ code: `taken_${token()}`, state })}`;
    return send(
      res,
      200,
      `<!doctype html><title>Fake ${escape(provider)}</title><h1>Fake ${escape(provider)} consent</h1>` +
        `<a href="${escape(allow)}">Authorize</a> <a href="${escape(taken)}">Use a taken account</a> <a href="${escape(deny)}">Deny</a>`,
      "text/html; charset=utf-8",
    );
  }

  if (req.method === "POST" && path === "/api/v1/auth/handoff") {
    const { code } = await readBody(req);
    const answer = typeof code === "string" ? handoffs.get(code) : undefined;
    if (!answer) return problem(res, 401, "invalid_token");
    handoffs.delete(code as string);
    return send(res, 200, answer);
  }
  if (req.method === "POST" && path === "/api/v1/auth/2fa/exchange") {
    const { pre_auth_token: raw, code, backup_code: backup } = await readBody(req);
    if ((typeof code === "string") === (typeof backup === "string")) return problem(res, 400, "invalid_request");
    const pre = typeof raw === "string" ? preAuths.get(raw) : undefined;
    if (!pre) return problem(res, 401, "invalid_token");
    pre.attempts++;
    const ok =
      typeof code === "string"
        ? totpValid(pre.secret, code)
        : pre.backupCodes.delete(normalizeBackup(String(backup)));
    if (!ok) {
      if (pre.attempts >= PRE_AUTH_MAX_ATTEMPTS) {
        preAuths.delete(raw as string);
        return problem(res, 429, "too_many_attempts");
      }
      return problem(res, 401, "invalid_code");
    }
    preAuths.delete(raw as string);
    return send(res, 200, bundle(pre.next));
  }
  if (req.method === "POST" && path === "/api/v1/auth/logout") return send(res, 204);
  if (req.method === "GET" && path === "/api/v1/users/me/context") {
    if (!req.headers.authorization?.startsWith("Bearer at_")) return problem(res, 401, "unauthenticated");
    // An access token whose session was revoked still reads a context here (as an owner).
    const user = userByAccess.get(req.headers.authorization.slice("Bearer ".length));
    return send(res, 200, context(user ?? randomUUID()));
  }
  const invite = path.match(/^\/api\/v1\/auth\/invitations\/([^/]+)(\/accept)?$/);
  if (invite) {
    const inv = INVITES[decodeURIComponent(invite[1])];
    if (invite[2] && req.method === "POST") {
      const user = signedInUser(req);
      if (!user) return problem(res, 401, "unauthenticated");
      if (!inv) return problem(res, 401, "invalid_token");
      if (inv.expired) return problem(res, 410, "invite_expired");
      if (inv.email !== profile.email) return problem(res, 403, "invite_email_mismatch");
      const joined = !joinedGlobex.has(user);
      joinedGlobex.add(user);
      return send(res, 200, { org: { id: GLOBEX.id, slug: GLOBEX.slug, name: GLOBEX.name, role: GLOBEX.role }, joined });
    }
    if (!invite[2] && req.method === "GET") {
      if (!inv) return problem(res, 401, "invalid_token");
      if (inv.expired) return problem(res, 410, "invite_expired");
      return send(res, 200, {
        org: { name: GLOBEX.name, slug: GLOBEX.slug },
        inviter_name: "Olive Owner",
        email_masked: inv.masked,
        role: "member",
        expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      });
    }
  }
  if (req.method === "GET" && path === "/api/v1/users/me/joinable-orgs") {
    const user = signedInUser(req);
    if (!user) return problem(res, 401, "unauthenticated");
    const joined = joinedByUser.get(user) ?? new Set<string>();
    return send(
      res,
      200,
      (joinableByUser.get(user) ?? [])
        .filter((o) => !joined.has(o.slug))
        .map((o) => ({
          id: o.id,
          slug: o.slug,
          name: o.name,
          member_count: o.member_count,
          project_count: o.projects.length,
          member_initials: o.member_initials,
        })),
    );
  }
  const joinPath = path.match(/^\/api\/v1\/orgs\/([^/]+)\/join$/);
  if (req.method === "POST" && joinPath) {
    const user = signedInUser(req);
    if (!user) return problem(res, 401, "unauthenticated");
    const org = (joinableByUser.get(user) ?? []).find((o) => o.slug === decodeURIComponent(joinPath[1]));
    if (!org) return problem(res, 403, "forbidden");
    const joined = joinedByUser.get(user) ?? new Set<string>();
    joined.add(org.slug);
    joinedByUser.set(user, joined);
    return send(res, 200, { id: org.id, slug: org.slug, name: org.name, role: "member", created_at: new Date().toISOString() });
  }
  if (req.method === "PATCH" && path === "/api/v1/users/me/onboarding") {
    const user = signedInUser(req);
    if (!user) return problem(res, 401, "unauthenticated");
    const { step, answers = {}, completed, ...rest } = await readBody(req);
    const valid =
      Object.keys(rest).length === 0 &&
      (completed === undefined || typeof completed === "boolean") &&
      (step === undefined || (typeof step === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(step))) &&
      typeof answers === "object" &&
      answers !== null &&
      !Array.isArray(answers) &&
      Object.entries(answers).every(([k, v]) => {
        const rule = ONBOARDING_ANSWERS[k];
        if (rule === "count") return Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 1000;
        return rule !== undefined && typeof v === "string" && rule.test(v);
      });
    if (!valid) return problem(res, 422, "invalid_request");
    const given = answers as Record<string, unknown>;
    if (given.org_slug === "unavailable") return problem(res, 503, "unavailable");
    const progress = onboardingOf(user);
    const saved = {
      step: typeof step === "string" ? step : progress.step,
      completed: typeof completed === "boolean" ? completed : progress.completed,
      answers: { ...progress.answers, ...given },
    };
    onboardingByUser.set(user, saved);
    return send(res, 200, { ...saved, completed_at: saved.completed ? new Date().toISOString() : null });
  }
  if (path === "/api/v1/users/me" || path.startsWith("/api/v1/users/me/email/")) {
    if (!req.headers.authorization?.startsWith("Bearer at_")) return problem(res, 401, "unauthenticated");
    const me = () => context(signedInUser(req) ?? randomUUID()).user;
    if (req.method === "GET" && path === "/api/v1/users/me") return send(res, 200, me());
    if (req.method === "PATCH" && path === "/api/v1/users/me") {
      const { name, preferences } = await readBody(req);
      if (name === undefined && preferences === undefined) return problem(res, 400, "invalid_request");
      if (name !== undefined && (typeof name !== "string" || name.trim().length > 120)) return problem(res, 400, "invalid_request");
      if (preferences !== undefined) {
        const user = signedInUser(req);
        const { home, ...rest } = (preferences ?? {}) as Record<string, unknown>;
        if (!user) return problem(res, 401, "unauthenticated");
        if (Object.keys(rest).length > 0 || typeof home !== "string" || !HOME_SCREENS.has(home)) return problem(res, 400, "invalid_request");
        preferencesByUser.set(user, { ...preferencesOf(user), home });
      }
      if (typeof name === "string") profile.name = name.trim();
      return send(res, 200, me());
    }
    if (req.method === "DELETE" && path === "/api/v1/users/me") {
      if (profile.soleOwner) return problem(res, 409, "owner_transfer_required");
      return send(res, 200, { delete_after: new Date(Date.now() + 30 * 86_400_000).toISOString() });
    }
    if (req.method === "POST" && path === "/api/v1/users/me/email/change") {
      const { new_email: email } = await readBody(req);
      if (typeof email !== "string" || !email.includes("@") || email.toLowerCase() === profile.email) {
        return problem(res, 400, "invalid_request");
      }
      if (email.toLowerCase() === "taken@example.com") return problem(res, 409, "email_taken");
      profile.pendingEmail = email.toLowerCase();
      return send(res, 202, { pending_email: profile.pendingEmail, expires_at: new Date(Date.now() + 900_000).toISOString() });
    }
    if (req.method === "POST" && path === "/api/v1/users/me/email/confirm") {
      const { code } = await readBody(req);
      if (!profile.pendingEmail || code !== "123456") return problem(res, 400, "invalid_code");
      profile.email = profile.pendingEmail;
      profile.pendingEmail = null;
      return send(res, 200, me());
    }
  }
  if (req.method === "POST" && path === "/__fake/profile") {
    const body = await readBody(req);
    Object.assign(profile, PROFILE_DEFAULTS, { pendingEmail: null });
    if (typeof body.name === "string") profile.name = body.name;
    if (typeof body.email === "string") profile.email = body.email;
    if (typeof body.sole_owner === "boolean") profile.soleOwner = body.sole_owner;
    return send(res, 200, { ok: true });
  }
  if (req.method === "GET" && path === "/api/v1/orgs/slug-available") {
    if (!signedInUser(req)) return problem(res, 401, "unauthenticated");
    const slug = q.get("slug") ?? "";
    if (!ORG_SLUG.test(slug)) return problem(res, 422, "invalid_request");
    const available = !orgSlugTaken(slug) || slug === RACE_SLUG;
    return send(res, 200, { available, suggestions: available ? [] : orgSlugSuggestions(slug) });
  }
  if (req.method === "POST" && path === "/api/v1/orgs") {
    const user = signedInUser(req);
    if (!user) return problem(res, 401, "unauthenticated");
    const { name, slug } = await readBody(req);
    const label = typeof name === "string" ? name.trim() : "";
    if (!label || label.length > 100 || typeof slug !== "string" || !ORG_SLUG.test(slug)) return problem(res, 422, "invalid_request");
    if (orgSlugTaken(slug)) {
      return send(res, 409, { status: 409, title: "slug_taken", code: "slug_taken", suggestions: orgSlugSuggestions(slug) }, "application/problem+json");
    }
    const org = { id: `org_${randomUUID()}`, slug, name: label, role: "owner", owner: user };
    createdOrgs.set(slug, org);
    return send(res, 201, { id: org.id, slug, name: label, role: "owner", created_at: new Date().toISOString() });
  }
  if (req.method === "GET" && path === "/api/v1/projects/slug-available") {
    if (!signedInUser(req)) return problem(res, 401, "unauthenticated");
    const slug = q.get("slug") ?? "";
    if (!ORG_SLUG.test(slug)) return problem(res, 422, "invalid_request");
    const available = !projectSlugTaken(slug) || slug === RACE_SLUG;
    return send(res, 200, { available, suggestions: available ? [] : projectSlugSuggestions(slug) });
  }
  const orgProjects = req.method === "POST" ? path.match(/^\/api\/v1\/orgs\/([^/]+)\/projects$/) : null;
  if (orgProjects) {
    const user = signedInUser(req);
    if (!user) return problem(res, 401, "unauthenticated");
    const org = context(user).orgs.find((o) => o.slug === orgProjects[1]);
    if (!org || org.role === "viewer") return problem(res, 403, "forbidden");
    const { name, slug, environments = ["production"] } = await readBody(req);
    const label = typeof name === "string" ? name.trim() : "";
    const envs = Array.isArray(environments) ? [...new Set(environments)] : null;
    if (
      !label ||
      label.length > 100 ||
      typeof slug !== "string" ||
      !ORG_SLUG.test(slug) ||
      !envs ||
      envs.length > 20 ||
      !envs.every((e) => typeof e === "string" && ENV_NAME.test(e))
    ) {
      return problem(res, 422, "invalid_request");
    }
    if (projectSlugTaken(slug)) {
      return send(res, 409, { status: 409, title: "slug_taken", code: "slug_taken", suggestions: projectSlugSuggestions(slug) }, "application/problem+json");
    }
    const project = { id: `prj_${randomUUID()}`, slug, name: label, environments: (envs as string[]).toSorted(), org: org.slug, owner: user };
    createdProjects.set(slug, project);
    return send(res, 201, {
      id: project.id,
      slug,
      name: label,
      org_id: org.id,
      org_slug: org.slug,
      role: org.role,
      environments: project.environments,
      created_at: new Date().toISOString(),
    });
  }
  const ssoPath = path.match(/^\/api\/v1\/orgs\/([^/]+)\/sso(\/test)?$/);
  if (ssoPath) return orgSSO(req, res, ssoPath[1], ssoPath[2] !== undefined);
  const orgPath = path.match(/^\/api\/v1\/orgs\/([^/]+)\/(members|transfer-ownership|invitations)(?:\/([^/]+)(\/resend)?)?$/);
  if (orgPath) return orgs(req, res, orgPath[1], orgPath[2], orgPath[3], orgPath[4] !== undefined);
  // shop's deny list (#599). Like the API: another project answers forbidden, saving needs
  // `project.update`, and a pattern that does not compile answers invalid_request naming it.
  const privacyPath = path.match(/^\/api\/v1\/projects\/([^/]+)\/privacy-policy$/);
  if (privacyPath) {
    const user = signedInUser(req);
    if (!user) return problem(res, 401, "unauthenticated");
    if (decodeURIComponent(privacyPath[1]) !== PROJECT) return problem(res, 403, "forbidden");
    if (req.method === "GET") return send(res, 200, privacyPolicyOf());
    if (req.method !== "PUT") return problem(res, 404, "not_found");
    if (!capabilitiesOf(user).includes("project.update")) return problem(res, 403, "forbidden");
    const body = await readBody(req);
    const saved = { mask_query_params: [] as string[], mask_headers: [] as string[], mask_body_fields: [] as string[], updated_at: new Date().toISOString() };
    for (const field of ["mask_query_params", "mask_headers", "mask_body_fields"] as const) {
      const list = body[field] ?? [];
      if (!Array.isArray(list) || list.length > 50) return problem(res, 422, "validation_failed");
      for (const [i, raw] of list.entries()) {
        const pat = String(raw).trim();
        if (pat === "" || saved[field].includes(pat)) continue;
        try {
          new RegExp(pat, "i");
        } catch {
          return send(res, 400, { status: 400, title: "invalid_request", code: "invalid_request", detail: `${field}[${i}]: not a valid RE2 pattern` }, "application/problem+json");
        }
        saved[field].push(pat);
      }
    }
    privacyPolicy = saved;
    return send(res, 200, privacyPolicyOf());
  }
  if (req.method === "POST" && path === "/__fake/privacy") {
    privacyPolicy = null;
    return send(res, 204);
  }
  const keysPath = path.match(/^\/api\/v1\/projects\/([^/]+)\/api-keys(?:\/([^/]+))?$/);
  if (keysPath) {
    const user = signedInUser(req);
    if (!user) return problem(res, 401, "unauthenticated");
    // Like the API: a project the user cannot see answers forbidden. Projects created in
    // onboarding (#333) have keys too; the fake keeps one list per user.
    const keysProject = decodeURIComponent(keysPath[1]);
    if (keysProject !== PROJECT && createdProjects.get(keysProject)?.owner !== user) return problem(res, 403, "forbidden");
    const list = apiKeys.get(user) ?? [];
    const allowed = (action: string) => capabilitiesOf(user).includes(action);
    const sub = keysPath[2];
    if (req.method === "GET" && sub === undefined) return send(res, 200, list);
    if (req.method === "POST" && sub === undefined) {
      if (!allowed("api_keys.create")) return problem(res, 403, "forbidden");
      const { name, scopes, expires_at: expires } = await readBody(req);
      const label = typeof name === "string" ? name.trim() : "";
      const picked = Array.isArray(scopes) ? scopes.map(String) : [];
      const valid = picked.length > 0 && picked.every((s) => s === "ingest" || s === "read") && new Set(picked).size === picked.length;
      const when = typeof expires === "string" ? Date.parse(expires) : undefined;
      if (!label || label.length > 100 || !valid || (when !== undefined && !(when > Date.now()))) return problem(res, 400, "invalid_request");
      const raw = `apl_live_${token()}`;
      const created: FakeApiKey = {
        id: randomUUID(),
        name: label,
        prefix: raw.slice(0, 16),
        scopes: ["ingest", "read"].filter((s) => picked.some((p) => p === s)),
        created_at: new Date().toISOString(),
        expires_at: when === undefined ? null : new Date(when).toISOString(),
        last_used_at: null,
        revoked_at: null,
      };
      apiKeys.set(user, [created, ...list]);
      rawKeys.set(raw, { project: keysProject, id: created.id, user });
      return send(res, 201, { ...created, key: raw });
    }
    if (req.method === "DELETE" && sub !== undefined) {
      if (!allowed("api_keys.revoke")) return problem(res, 403, "forbidden");
      const found = list.find((k) => k.id === decodeURIComponent(sub));
      if (!found) return problem(res, 410, "api_key_gone");
      found.revoked_at ??= new Date().toISOString();
      return send(res, 204);
    }
    return problem(res, 404, "not_found");
  }
  const statusPath = path.match(/^\/api\/v1\/projects\/([^/]+)\/ingest-status$/);
  if (statusPath && req.method === "GET") {
    const user = signedInUser(req);
    if (!user) return problem(res, 401, "unauthenticated");
    const slug = decodeURIComponent(statusPath[1]);
    if (slug !== PROJECT && createdProjects.get(slug)?.owner !== user) return problem(res, 403, "forbidden");
    const got = ingested.get(slug);
    return send(res, 200, { received: Boolean(got), first_at: got?.first_at ?? null, last_at: got?.last_at ?? null, count_1h: got?.count ?? 0 });
  }
  if (req.method === "POST" && path === "/v1/requests") {
    // The edge's v1 contract (internal/ingest): the key in X-API-Key, `{requests: [...]}` each with
    // an app_id, method and path; `{accepted}` back. Errors are `{error, detail}`.
    const holder = rawKeys.get(String(req.headers["x-api-key"] ?? "").trim());
    const revoked = holder && apiKeys.get(holder.user)?.find((k) => k.id === holder.id)?.revoked_at;
    if (!holder || revoked) return send(res, 401, { error: "authentication_error", detail: "Authentication required" });
    const { requests } = await readBody(req);
    const list = Array.isArray(requests) ? (requests as Record<string, unknown>[]) : [];
    const valid = list.length > 0 && list.every((r) => typeof r.app_id === "string" && r.app_id && typeof r.method === "string" && typeof r.path === "string");
    if (!valid) return send(res, 422, { error: "validation_error", detail: "app_id, method and path are required" });
    const now = new Date().toISOString();
    const was = ingested.get(holder.project);
    ingested.set(holder.project, { first_at: was?.first_at ?? now, last_at: now, count: (was?.count ?? 0) + list.length });
    const rows = ingestedRows.get(holder.project) ?? [];
    for (const r of list) {
      const raw = String(r.path);
      rows.unshift({
        timestamp: now,
        method: String(r.method).toUpperCase(),
        path: raw.split("?")[0].replace(/\/\d+(?=\/|$)/g, "/{id}"),
        raw_path: raw,
        status_code: typeof r.status_code === "number" ? r.status_code : 200,
        response_time_ms: typeof r.response_time_ms === "number" ? r.response_time_ms : 0,
        environment: typeof r.environment === "string" ? r.environment : "production",
        consumer_id: "",
        consumer_name: "",
        trace_id: randomUUID().replaceAll("-", ""),
      });
    }
    ingestedRows.set(holder.project, rows);
    return send(res, 200, { accepted: list.length });
  }
  // shop's apps and their capture policies (#598). Like the API, an app in a project the user
  // cannot view answers 404; saving needs `capture.manage`.
  if (req.method === "GET" && path === "/api/v1/project") {
    const user = signedInUser(req);
    if (!user) return problem(res, 401, "unauthenticated");
    if (url.searchParams.get("project") !== PROJECT) return problem(res, 404, "not_found");
    return send(res, 200, { org: { id: "org_acme", slug: "acme", name: "Acme" }, project: { id: "prj_shop", slug: PROJECT, name: "Shop" }, apps: shopApps, environments: ["production"] });
  }
  const appPath = path.match(/^\/api\/v1\/apps\/([^/]+)\/(capture-policy|metadata)$/);
  if (appPath) {
    const user = signedInUser(req);
    if (!user) return problem(res, 401, "unauthenticated");
    const app = shopApps.find((a) => a.id === decodeURIComponent(appPath[1]));
    if (!app) return problem(res, 404, "not_found");
    if (appPath[2] === "metadata" && req.method === "GET") return send(res, 200, { app_id: app.id, environments: appReports.get(app.id) ?? [] });
    if (appPath[2] === "capture-policy" && req.method === "GET") return send(res, 200, capturePolicyOf(app));
    if (appPath[2] === "capture-policy" && req.method === "PUT") {
      if (!capabilitiesOf(user).includes("capture.manage")) return problem(res, 403, "forbidden");
      const body = await readBody(req);
      const flags = ["enabled", "capture_headers", "capture_request_body", "capture_response_body"];
      const rate = body.sample_rate;
      const cap = body.max_payload_bytes ?? null;
      const valid =
        flags.every((f) => typeof body[f] === "boolean") &&
        typeof rate === "number" &&
        rate >= 0 &&
        rate <= 1 &&
        (cap === null || (typeof cap === "number" && Number.isInteger(cap) && cap >= 1 && cap <= 1_048_576));
      if (!valid) return problem(res, 422, "validation_failed");
      if (Math.round((rate as number) * 10_000) / 10_000 !== rate) return problem(res, 400, "invalid_request");
      capturePolicies.set(app.id, {
        ...Object.fromEntries(flags.map((f) => [f, body[f]])),
        sample_rate: rate,
        max_payload_bytes: cap,
        updated_at: new Date().toISOString(),
        updated_by: user,
      });
      return send(res, 200, capturePolicyOf(app));
    }
    return problem(res, 404, "not_found");
  }
  if (req.method === "POST" && path === "/__fake/apps") {
    // Test hook: replaces shop's apps, their saved policies and their SDK reports.
    const { apps } = await readBody(req);
    const list = Array.isArray(apps) ? (apps as Record<string, unknown>[]) : [];
    capturePolicies.clear();
    appReports.clear();
    shopApps = list.length ? list.map((a) => ({ id: String(a.id ?? randomUUID()), slug: String(a.slug), name: String(a.name ?? a.slug) })) : [DEFAULT_APP];
    list.forEach((a, i) => {
      const id = shopApps[i].id;
      if (typeof a.policy === "object" && a.policy !== null) capturePolicies.set(id, a.policy as Record<string, unknown>);
      if (Array.isArray(a.environments)) appReports.set(id, a.environments as Record<string, unknown>[]);
    });
    return send(res, 204);
  }
  // The query role's dashboard reads as a session (#295, #335): the project in `?project=`; a
  // project the user cannot view answers 404, as internal/query does.
  if (req.method === "GET" && (path === "/api/v1/requests" || path === "/api/v1/traffic/summary" || path === "/api/v1/traffic/endpoints")) {
    const user = signedInUser(req);
    if (!user) return problem(res, 401, "unauthenticated");
    const slug = url.searchParams.get("project") ?? "";
    if (slug !== PROJECT && createdProjects.get(slug)?.owner !== user) return problem(res, 404, "not_found");
    if (queryDown.has(slug)) return problem(res, 503, "unavailable");
    const rows = ingestedRows.get(slug) ?? [];
    if (path === "/api/v1/requests") {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 100) || 100));
      return send(res, 200, { requests: rows.slice(0, limit) });
    }
    const p95 = (list: typeof rows) => {
      const sorted = list.map((r) => r.response_time_ms).sort((a, b) => a - b);
      return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] : 0;
    };
    const errs = (list: typeof rows, lo: number) => list.filter((r) => r.status_code >= lo && r.status_code < lo + 100).length;
    if (path === "/api/v1/traffic/endpoints") {
      const groups = new Map<string, typeof rows>();
      for (const r of rows) groups.set(`${r.method} ${r.path}`, [...(groups.get(`${r.method} ${r.path}`) ?? []), r]);
      const endpoints = [...groups.values()].map((g) => ({
        method: g[0].method,
        path: g[0].path,
        requests: g.length,
        client_errors: errs(g, 400),
        server_errors: errs(g, 500),
        error_rate: (errs(g, 400) + errs(g, 500)) / g.length,
        p50_ms: p95(g),
        p95_ms: p95(g),
      }));
      return send(res, 200, { endpoints });
    }
    const to = new Date();
    const range = url.searchParams.get("range") ?? "24h";
    return send(res, 200, {
      range,
      from: new Date(to.getTime() - 7 * 86_400_000).toISOString(),
      to: to.toISOString(),
      requests: rows.length,
      client_errors: errs(rows, 400),
      server_errors: errs(rows, 500),
      error_rate: rows.length ? (errs(rows, 400) + errs(rows, 500)) / rows.length : 0,
      p50_ms: p95(rows),
      p95_ms: p95(rows),
      p99_ms: p95(rows),
      requests_per_minute: rows.length / (7 * 24 * 60),
    });
  }
  // Deploys with their before/after numbers (#597), as seeded; same access rules as above.
  if (req.method === "GET" && path === "/api/v1/deploys/changes") {
    const user = signedInUser(req);
    if (!user) return problem(res, 401, "unauthenticated");
    const slug = url.searchParams.get("project") ?? "";
    if (slug !== PROJECT && createdProjects.get(slug)?.owner !== user) return problem(res, 404, "not_found");
    if (queryDown.has(slug)) return problem(res, 503, "unavailable");
    return send(res, 200, { window_minutes: 60, deploys: deployChanges.get(slug) ?? [] });
  }
  if (req.method === "POST" && path === "/__fake/deploys") {
    // Test hook: replaces what `GET /deploys/changes` answers for `project`.
    const { project, deploys } = await readBody(req);
    deployChanges.set(String(project), Array.isArray(deploys) ? deploys : []);
    return send(res, 204);
  }
  if (req.method === "POST" && path === "/__fake/query-down") {
    // Test hook: the query API answers 503 for `project` (#335's error state), or again normally.
    const { project, down } = await readBody(req);
    if (down) queryDown.add(String(project));
    else queryDown.delete(String(project));
    return send(res, 204);
  }
  const sessionPath = path.match(/^\/api\/v1\/users\/me\/sessions(?:\/([^/]+))?$/);
  if (sessionPath) {
    const access = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    const user = userByAccess.get(access);
    const all = user ? sessionsByUser.get(user) : undefined;
    if (!user || !all) return problem(res, 401, "unauthenticated");
    const sub = sessionPath[1];
    if (req.method === "GET" && sub === undefined) {
      const sessions = all
        .map(({ access: holder, ...rest }) => ({ ...rest, current: holder === access }))
        .sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at));
      return send(res, 200, { sessions });
    }
    if (req.method === "POST" && sub === "revoke-others") {
      const keep = all.filter((s) => s.access === access);
      sessionsByUser.set(user, keep);
      return send(res, 200, { revoked: all.length - keep.length });
    }
    if (req.method === "DELETE" && sub !== undefined) {
      const gone = all.find((s) => s.id === sub);
      sessionsByUser.set(user, all.filter((s) => s.id !== sub));
      if (gone?.access) userByAccess.delete(gone.access);
      return send(res, 204);
    }
  }
  if (path === "/api/v1/users/me/identities" || path.startsWith("/api/v1/users/me/identities/")) {
    if (!req.headers.authorization?.startsWith("Bearer at_")) return problem(res, 401, "unauthenticated");
    if (req.method === "GET" && path === "/api/v1/users/me/identities") return send(res, 200, { identities });
    if (req.method === "DELETE") {
      const id = decodeURIComponent(path.slice("/api/v1/users/me/identities/".length));
      const before = identities.length;
      identities = identities.filter((i) => i.id !== id);
      return identities.length < before ? send(res, 204) : problem(res, 410, "oauth_identity_gone");
    }
  }
  if (req.method === "POST" && path === "/__fake/identities") {
    const body = await readBody(req);
    identities = Array.isArray(body.identities) ? (body.identities as Identity[]) : [];
    return send(res, 200, { identities });
  }
  if (path.startsWith("/api/v1/auth/passkeys/register/") || path.startsWith("/api/v1/users/me/passkeys")) {
    const user = signedInUser(req);
    if (!user) return problem(res, 401, "unauthenticated");
    const list = passkeys.get(user) ?? [];

    if (req.method === "POST" && path === "/api/v1/auth/passkeys/register/options") {
      const id = token();
      const challenge = b64u(randomBytes(32));
      registrations.set(id, { user, challenge });
      return send(res, 200, {
        challenge_id: id,
        options: {
          publicKey: {
            challenge,
            rp: { id: new URL(UI_URL).hostname, name: "APILens" },
            user: { id: b64u(Buffer.from(user)), name: "you@example.com", displayName: "Fake User" },
            pubKeyCredParams: [
              { type: "public-key", alg: -7 },
              { type: "public-key", alg: -257 },
            ],
            timeout: 60_000,
            excludeCredentials: list.map((p) => ({ type: "public-key", id: p.credential_id })),
            authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "preferred" },
            attestation: "none",
          },
        },
      });
    }
    if (req.method === "POST" && path === "/api/v1/auth/passkeys/register/verify") {
      const { challenge_id: id, response, name } = await readBody(req);
      const reg = typeof id === "string" ? registrations.get(id) : undefined;
      if (typeof id === "string") registrations.delete(id);
      const credential = response as { rawId?: string; response?: { clientDataJSON?: string; transports?: string[] } } | undefined;
      if (!reg || reg.user !== user || !credential?.rawId || !credential.response?.clientDataJSON) {
        return problem(res, 401, "passkey_failed");
      }
      const client = JSON.parse(Buffer.from(credential.response.clientDataJSON, "base64url").toString("utf8"));
      if (client.type !== "webauthn.create" || client.challenge !== reg.challenge || client.origin !== UI_URL) {
        return problem(res, 401, "passkey_failed");
      }
      if ([...passkeys.values()].flat().some((p) => p.credential_id === credential.rawId)) {
        return problem(res, 409, "passkey_already_registered");
      }
      const label = typeof name === "string" ? name.trim() : "";
      if (label.length > 64) return problem(res, 400, "invalid_request");
      const stored: FakePasskey = {
        id: randomUUID(),
        credential_id: credential.rawId,
        // Identity names it after the authenticator, or the browser and OS; the virtual
        // authenticator reports no AAGUID.
        name: label || "Chrome",
        aaguid: ZERO_AAGUID,
        authenticator: "",
        transports: credential.response.transports ?? [],
        backup_eligible: false,
        backup_state: false,
        created_at: new Date().toISOString(),
        last_used_at: null,
      };
      passkeys.set(user, [...list, stored]);
      return send(res, 201, listed(stored));
    }
    if (req.method === "GET" && path === "/api/v1/users/me/passkeys") {
      return send(res, 200, { passkeys: list.map(listed) });
    }
    const one = path.match(/^\/api\/v1\/users\/me\/passkeys\/([^/]+)$/);
    const found = one ? list.find((p) => p.id === decodeURIComponent(one[1])) : undefined;
    if (one && req.method === "PATCH") {
      const { name } = await readBody(req);
      const label = typeof name === "string" ? name.trim() : "";
      if (!label || label.length > 64) return problem(res, 400, "invalid_request");
      if (!found) return problem(res, 410, "passkey_gone");
      found.name = label;
      return send(res, 200, listed(found));
    }
    if (one && req.method === "DELETE") {
      if (!found) return problem(res, 410, "passkey_gone");
      passkeys.set(
        user,
        list.filter((p) => p !== found),
      );
      return send(res, 204);
    }
    return problem(res, 404, "not_found");
  }

  if (path.startsWith("/api/v1/auth/2fa/") && path !== "/api/v1/auth/2fa/exchange") {
    const t = totps.get(req.headers.authorization?.replace(/^Bearer /, "") ?? "");
    if (!t) return problem(res, 401, "unauthenticated");
    return twoFactor(req, res, path.slice("/api/v1/auth/2fa".length), t);
  }
  if (req.method === "POST" && path === "/__fake/handoff") {
    const {
      next,
      role,
      totp_secret: secret,
      backup_codes: backups,
      passkeys: seeds,
      capabilities: caps,
      api_keys: keys,
      sso,
      stale,
      joinable,
    } = await readBody(req);
    const codes = Array.isArray(backups) ? backups.map(String) : [];
    const seeded: Seeds = {
      passkeys: Array.isArray(seeds) ? (seeds as Record<string, unknown>[]) : [],
      capabilities: Array.isArray(caps) ? caps.map(String) : undefined,
      apiKeys: Array.isArray(keys) ? (keys as Record<string, unknown>[]) : [],
      sso: typeof sso === "object" && sso !== null && !Array.isArray(sso) ? (sso as Record<string, unknown>) : undefined,
      joinable: Array.isArray(joinable) ? (joinable as Record<string, unknown>[]) : [],
    };
    const r = ROLES.has(role as Role) ? (role as Role) : "owner";
    const code = issueHandoff(String(next ?? "/"), typeof secret === "string" ? secret : undefined, codes, seeded, stale === true, r);
    return send(res, 200, { code });
  }
  return problem(res, 404, "not_found");
}

/** The two-factor settings endpoints, with identity's answers and status codes. */
async function twoFactor(req: IncomingMessage, res: ServerResponse, route: string, t: Totp) {
  const status = () => ({
    enabled: t.secret !== null,
    confirmed_at: t.confirmedAt,
    backup_codes_remaining: t.secret ? t.backupCodes.size : 0,
  });
  const totpCode = (v: unknown) => (typeof v === "string" && /^[0-9]{6}$/.test(v) ? v : null);

  if (req.method === "GET" && route === "/status") return send(res, 200, status());
  if (req.method !== "POST") return problem(res, 404, "not_found");
  const body = await readBody(req);

  if (route === "/enable") {
    if (t.stale) return problem(res, 403, "reauth_required");
    if (t.secret) return problem(res, 409, "already_enabled");
    t.pending = randomBytes(20);
    const secret = base32Encode(t.pending);
    const uri = `otpauth://totp/APILens:you%40example.com?secret=${secret}&issuer=APILens&algorithm=SHA1&digits=6&period=30`;
    return send(res, 200, { secret, otpauth_uri: uri });
  }
  if (route === "/verify") {
    const code = totpCode(body.code);
    if (!code) return problem(res, 422, "validation_failed");
    if (t.secret) return problem(res, 409, "already_enabled");
    if (!t.pending) return problem(res, 400, "invalid_request");
    if (!totpValid(t.pending, code)) return problem(res, 401, "invalid_totp");
    const codes = newBackupCodes();
    t.secret = t.pending;
    t.pending = null;
    t.confirmedAt = new Date().toISOString();
    t.backupCodes = new Set(codes.map(normalizeBackup));
    return send(res, 200, { backup_codes: codes });
  }
  if (route === "/disable") {
    const code = typeof body.code === "string" ? body.code : null;
    const backup = typeof body.backup_code === "string" ? body.backup_code : null;
    if ((code === null) === (backup === null)) return problem(res, 400, "invalid_request");
    if (!t.secret) return problem(res, 409, "not_enabled");
    const ok = code !== null ? totpValid(t.secret, code) : t.backupCodes.delete(normalizeBackup(backup as string));
    if (!ok) return problem(res, 401, "invalid_totp");
    t.secret = null;
    t.confirmedAt = null;
    t.backupCodes = new Set();
    return send(res, 204);
  }
  if (route === "/backup-codes/regenerate") {
    const code = totpCode(body.code);
    if (!code) return problem(res, 422, "validation_failed");
    if (!t.secret) return problem(res, 409, "not_enabled");
    if (!totpValid(t.secret, code)) return problem(res, 401, "invalid_totp");
    const codes = newBackupCodes();
    t.backupCodes = new Set(codes.map(normalizeBackup));
    return send(res, 200, { backup_codes: codes });
  }
  return problem(res, 404, "not_found");
}

/** The acme organization's member endpoints, with the API's rules (internal/controlplane/orgs/members.go). */
async function orgs(req: IncomingMessage, res: ServerResponse, slug: string, what: string, sub: string | undefined, resend = false) {
  const user = userByAccess.get(req.headers.authorization?.replace(/^Bearer /, "") ?? "");
  const members = user ? membersByUser.get(user) : undefined;
  if (!user || !members) return problem(res, 401, "unauthenticated");
  if (slug !== "acme") {
    // Onboarding's 'Invite your team' (#336) invites to the organization the user just created.
    if (createdOrgs.get(slug)?.owner === user && what === "invitations" && sub === undefined && req.method === "POST") {
      return inviteToCreatedOrg(req, res, user, slug, members.filter((m) => m.user.id === user));
    }
    return problem(res, 404, "not_found");
  }
  const me = roleOf(user);
  const manage = me === "owner" || me === "admin";
  const owners = members.filter((m) => m.role === "owner").length;
  const target = sub ? members.find((m) => m.user.id === sub) : undefined;

  if (what === "members" && sub === undefined && req.method === "GET") return send(res, 200, members);
  if (what === "members" && sub !== undefined && (req.method === "PATCH" || req.method === "DELETE")) {
    const role = req.method === "PATCH" ? ((await readBody(req)).role as Role) : undefined;
    if (req.method === "PATCH" && !ROLES.has(role as Role)) return problem(res, 400, "invalid_request");
    if (!manage) return problem(res, 403, "forbidden");
    if (!target) return problem(res, 410, "member_gone");
    if ((target.role === "owner" || role === "owner") && me !== "owner") return problem(res, 403, "forbidden");
    if (target.role === "owner" && role !== "owner" && owners <= 1) return problem(res, 409, "last_owner");
    if (role === undefined) {
      membersByUser.set(user, members.filter((m) => m !== target));
      return send(res, 204);
    }
    target.role = role;
    return send(res, 200, target);
  }
  if (what === "transfer-ownership" && sub === undefined && req.method === "POST") {
    const { user_id: to } = await readBody(req);
    if (me !== "owner") return problem(res, 403, "forbidden");
    if (to === user) return problem(res, 400, "invalid_request");
    const next = members.find((m) => m.user.id === to);
    if (!next) return problem(res, 410, "member_gone");
    next.role = "owner";
    const self = members.find((m) => m.user.id === user);
    if (self) self.role = "admin";
    return send(res, 204);
  }
  const invitations = invitationsByUser.get(user) ?? [];
  if (what === "invitations" && sub === undefined && req.method === "GET") {
    if (!manage) return problem(res, 403, "forbidden");
    return send(res, 200, [...invitations].sort((a, b) => b.created_at.localeCompare(a.created_at)));
  }
  if (what === "invitations" && sub === undefined && req.method === "POST") {
    const { invites } = await readBody(req);
    if (!manage) return problem(res, 403, "forbidden");
    if (!Array.isArray(invites) || invites.length === 0 || invites.length > 50) return problem(res, 400, "invalid_request");
    const self = members.find((m) => m.user.id === user);
    const seen = new Set<string>();
    const results = invites.map((i: { email?: unknown; role?: unknown }) => {
      const email = String(i.email ?? "").toLowerCase();
      const role = String(i.role ?? "member") as FakeInvitation["role"];
      if (seen.has(email)) return { email, status: "duplicate" };
      seen.add(email);
      if (members.some((m) => m.user.email === email)) return { email, status: "already_member" };
      const list = invitationsByUser.get(user) ?? [];
      const replaced = list.some((v) => v.email === email);
      const now = Date.now();
      const invitation: FakeInvitation = {
        id: randomUUID(),
        email,
        role,
        created_at: new Date(now).toISOString(),
        expires_at: new Date(now + INVITE_TTL_MS).toISOString(),
        resent_at: null,
        invited_by: self ? { id: self.user.id, email: self.user.email, name: self.user.name } : undefined,
      };
      invitationsByUser.set(user, [...list.filter((v) => v.email !== email), invitation]);
      return { email, status: replaced ? "replaced" : "invited", invitation };
    });
    return send(res, 200, { results });
  }
  if (what === "invitations" && sub !== undefined && ((resend && req.method === "POST") || (!resend && req.method === "DELETE"))) {
    if (!manage) return problem(res, 403, "forbidden");
    const inv = invitations.find((v) => v.id === sub);
    if (!inv) return problem(res, 410, "invite_expired");
    if (!resend) {
      invitationsByUser.set(user, invitations.filter((v) => v !== inv));
      return send(res, 204);
    }
    const wait = Date.parse(inv.resent_at ?? inv.created_at) + RESEND_COOLDOWN_MS - Date.now();
    if (wait > 0) {
      const retry = Math.max(1, Math.ceil(wait / 1000));
      res.writeHead(429, { "content-type": "application/problem+json", "retry-after": String(retry), "cache-control": "no-store" });
      return res.end(JSON.stringify({ status: 429, title: "rate_limited", code: "rate_limited", retry_after: retry }));
    }
    const now = Date.now();
    inv.resent_at = new Date(now).toISOString();
    inv.expires_at = new Date(now + INVITE_TTL_MS).toISOString();
    return send(res, 200, inv);
  }
  return problem(res, 404, "not_found");
}

/** Invitations to the organizations users created in onboarding (#336), by org slug. */
const createdOrgInvitations = new Map<string, Set<string>>();

/**
 * `POST /orgs/{slug}/invitations` on an organization the user created (#336), with the API's
 * per-address results: the creator is its only member. Inviting `down@example.com` answers 503
 * unavailable, for the error path.
 */
async function inviteToCreatedOrg(req: IncomingMessage, res: ServerResponse, user: string, slug: string, members: FakeMember[]) {
  const { invites } = await readBody(req);
  if (!Array.isArray(invites) || invites.length === 0 || invites.length > 50) return problem(res, 400, "invalid_request");
  const emails = invites.map((i: { email?: unknown }) => String(i.email ?? "").toLowerCase());
  if (emails.includes("down@example.com")) return problem(res, 503, "unavailable");
  const pending = createdOrgInvitations.get(slug) ?? new Set<string>();
  createdOrgInvitations.set(slug, pending);
  const seen = new Set<string>();
  const now = Date.now();
  const self = members[0];
  const results = invites.map((i: { email?: unknown; role?: unknown }) => {
    const email = String(i.email ?? "").toLowerCase();
    if (seen.has(email)) return { email, status: "duplicate" };
    seen.add(email);
    if (members.some((m) => m.user.email === email)) return { email, status: "already_member" };
    const replaced = pending.has(email);
    pending.add(email);
    const invitation: FakeInvitation = {
      id: randomUUID(),
      email,
      role: String(i.role ?? "member") as FakeInvitation["role"],
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + INVITE_TTL_MS).toISOString(),
      resent_at: null,
      invited_by: self ? { id: user, email: self.user.email, name: self.user.name } : undefined,
    };
    return { email, status: replaced ? "replaced" : "invited", invitation };
  });
  return send(res, 200, { results });
}

/** acme's SSO connection endpoints, with the API's rules (internal/controlplane/orgs/sso_connection.go). */
async function orgSSO(req: IncomingMessage, res: ServerResponse, slug: string, test: boolean) {
  const user = signedInUser(req);
  if (!user || !membersByUser.has(user)) return problem(res, 401, "unauthenticated");
  if (slug !== "acme") return problem(res, 404, "not_found");
  if (roleOf(user) !== "owner") return problem(res, 403, "forbidden");
  const cur = ssoByUser.get(user);

  if (test && req.method === "POST") {
    const body = await readBody(req);
    const issuer = typeof body.issuer === "string" && body.issuer ? body.issuer : (cur?.issuer as string | undefined);
    if (!issuer) return problem(res, 409, "sso_not_configured");
    if (issuer.includes("broken")) return send(res, 200, { ok: false, issuer, error: "unreachable" });
    const base = issuer.replace(/\/+$/, "");
    return send(res, 200, {
      ok: true,
      issuer,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      userinfo_endpoint: `${base}/userinfo`,
      jwks_uri: `${base}/jwks`,
      scopes_supported: ["openid", "email", "profile"],
      response_types_supported: ["code"],
      id_token_signing_alg_values_supported: ["RS256"],
    });
  }
  if (test) return problem(res, 404, "not_found");
  if (req.method === "GET") return cur ? send(res, 200, cur) : problem(res, 409, "sso_not_configured");
  if (req.method === "DELETE") {
    if (!cur) return problem(res, 409, "sso_not_configured");
    ssoByUser.delete(user);
    return send(res, 204);
  }
  if (req.method === "PUT") {
    const body = await readBody(req);
    const secret = typeof body.client_secret === "string" && body.client_secret !== "********" ? body.client_secret : "";
    const domains = Array.isArray(body.domains) ? body.domains.map(String) : [];
    if (typeof body.issuer !== "string" || !body.issuer || typeof body.client_id !== "string" || !body.client_id || domains.length === 0) {
      return problem(res, 400, "invalid_request");
    }
    if (!cur && !secret) return problem(res, 400, "invalid_request");
    if (domains.some((d: string) => d === "gmail.com" || d === "outlook.com")) return problem(res, 422, "domain_not_allowed");
    if (body.enforce === true && !(cur?.enforce === true) && !cur?.last_login_at) return problem(res, 409, "sso_untested");
    const next = ssoConnection({
      ...(cur ?? {}),
      issuer: body.issuer,
      client_id: body.client_id,
      domains,
      enforce: body.enforce === true,
      default_role: typeof body.default_role === "string" ? body.default_role : "member",
      updated_at: new Date().toISOString(),
    });
    ssoByUser.set(user, next);
    return send(res, 200, next);
  }
  return problem(res, 404, "not_found");
}

createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) problem(res, 500, "internal_error");
  });
}).listen(PORT, () => console.log(`fake identity on ${SELF} (ui ${UI_URL})`));
