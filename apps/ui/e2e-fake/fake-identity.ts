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
//   GET  /api/v1/traffic/timeseries?project=       with a `/__fake/traffic` seed for the project (#592), the
//                                                  summary, endpoints and timeseries reads answer the seed of
//                                                  `env` (else of "", all environments); without one, no points
//   POST /__fake/traffic {project, envs: {"": {summary, points, endpoints}, production: …}}
//                                                  test hook: what those answer for `project`; envs {} forgets it
//   GET  /api/v1/endpoints/{method}/{path}/{requests|errors|latency|transfer}?project=
//                                                  one endpoint's detail reads (#593) as seeded, else empty;
//                                                  every read is logged with its query
//   POST /__fake/endpoint {project, method, path, tabs: {requests?, errors?, latency?, transfer?}}
//                                                  test hook: what those answer; clears the log and that endpoint's settings
//   GET  /__fake/endpoint-reads                    test hook: the logged reads [{tab, method, path, query}]
//   GET|PUT /api/v1/apps/{id}/endpoints/{method}/{path}/settings
//                                                  an endpoint's settings (#593): defaults until saved; PUT
//                                                  answers 403 without capture.manage
//   GET  /api/v1/errors/status?project=            the errors dashboard (#594), computed from the rows
//   GET  /api/v1/errors/status/{code}?project=     `/__fake/errors` seeded: a status code an endpoint's
//   GET  /api/v1/errors?project=                   saved settings (any app) mark as expected is no error
//   POST /__fake/errors {project, buckets, requests, rows, down?}
//                                                  test hook: bucket starts, requests per bucket and error
//                                                  rows [{method, path, status_code, bucket, count, consumer_id?,
//                                                  consumer_name?, validation_errors?, exceptions?}]; forgets
//                                                  the settings of those endpoints; down: those reads answer 503
//   GET  /api/v1/traffic/latency?project=&env=     the Performance page's report (#595) as seeded, its Apdex
//                                                  scored over the seed's response times against shop's
//                                                  first app threshold (else 500 ms); empty without a seed
//   POST /__fake/performance {project, latency?, samples_ms?, endpoints?, down?}
//                                                  test hook: what that answers, and what the Performance
//                                                  page's `/traffic/endpoints?limit=500` read answers
//                                                  (`down`: both answer 503); clears the app thresholds
//   GET|PUT /api/v1/apps/{id}/settings             an app's response time threshold (#595): null until
//                                                  saved; PUT answers 403 without capture.manage
//   GET  /api/v1/deploys/changes?project=          deploys with before/after numbers (#597), as seeded
//   POST /__fake/deploys {project, deploys}        test hook: what that answers for `project`
//   GET  /api/v1/consumers?project=&group=&search=&sort=&limit=&offset=  consumers of shop (#596) as seeded,
//                                                  each with its seeded SDK consumer_group; `group` filters by it
//   GET  /api/v1/consumers/{consumer_id}?project=  detail as seeded, recent lists paged by limit/offset
//   GET  /api/v1/consumer-groups?project=          the seeded consumers rolled up by consumer_group
//   GET|POST /api/v1/projects/shop/consumer-groups shop's dashboard consumer groups (#596, deprecated; alert rules
//                                                  still list them): list (by name) and create; a name
//   PUT|DELETE /api/v1/projects/shop/consumer-groups/{id}  taken ignoring case answers 409 conflict
//   PUT|DELETE /api/v1/projects/shop/consumers/{consumer_id}/group  assign (moves it out of its previous
//                                                  group) and unassign; writes answer 403 without project.update
//   GET|POST /api/v1/projects/shop/views?surface=  shop's saved views (#578, #589): shared ones and the caller's
//   GET|PUT|DELETE /api/v1/projects/shop/views/{id} own; the creator edits, capture.manage edits shared ones (else
//                                                  403); a name the creator uses on the surface answers 409
//   POST /__fake/views {views?, down?}             test hook: replaces shop's saved views; `down`: writes answer 503
//   POST /__fake/consumers {project, summary, points, consumers, details, groups?, assignments?}
//                                                  test hook: what those answer; resets shop's groups
//   POST /__fake/requests {project, rows}          test hook: `GET /api/v1/requests` answers `rows` for
//                                                  `project` (narrowed by method, path and status,
//                                                  #586) instead of what the edge stored (#585); rows null forgets it
//   GET  /api/v1/requests/{id}?project=            one request (#588): the seeded row with that `id`, merged with
//                                                  its `detail` ({request?, spans?, logs?}); 404 for any other id
//   POST /__fake/query-down {project, down}        test hook: those reads answer 503 for `project`
//   GET  /api/v1/requests/timeline?project=        the Explore timeline (#587): the seeded request rows in the
//                                                  window counted per bucket by status class; the log's seed
//                                                  also honours from/to
//   POST /__fake/timeline-down {project, down}     test hook: only the timeline answers 503 for `project`
//   GET  /api/v1/project?project=shop              shop's apps (#598): one app `shop` unless seeded
//   GET|PUT /api/v1/apps/{id}/capture-policy       the app's capture policy (#598): everything captured
//                                                  until saved; PUT answers 403 without capture.manage
//   GET  /api/v1/apps/{id}/metadata                what the app's SDKs reported, per environment (#598)
//   GET|POST /api/v1/projects/shop/alerts/rules    shop's alert rules (#610): list (by name) and create; an app
//   GET|PUT|DELETE /api/v1/projects/shop/alerts/rules/{id}  that is not shop's answers 422
//   GET|POST /api/v1/projects/shop/alerts/channels shop's alert channels (#610), configs never returned; a name
//   PUT|DELETE /api/v1/projects/shop/alerts/channels/{id}   taken ignoring case answers 409
//   POST /api/v1/projects/shop/alerts/channels/{id}/test    a test send: 200 {sent}, or 502 for a channel
//                                                  whose config URL contains "gone" (HTTP 410 in the detail)
//   GET  /api/v1/projects/shop/alerts/events?rule_id=  events newest first
//   GET  /api/v1/projects/{slug}/incidents         events grouped by rule, open first (empty for created projects);
//                                                  alert writes answer 403 without alerts.manage
//   POST /__fake/alerts {trigger?: {rule, value}, resolve?: rule, reset?}
//                                                  test hook: the evaluator's part: open an event for the rule
//                                                  named `rule`, resolve its open one, or forget every rule,
//                                                  channel and event
//   GET  /api/v1/apps/{id}/ingest-stats?project=shop&days=
//                                                  the app's ingest-edge counters per UTC day (#602):
//                                                  all zero unless seeded; 503 when seeded `ingest: "off"`
//   GET  /api/v1/apps/{id}/status?project=shop     the app's status with its SDK counters (#602): no
//                                                  instance seen unless seeded `sdk_stats`; a seeded
//                                                  `status` (#591) overrides any field of the read
//   GET  /api/v1/traffic/{summary|timeseries}?app= one app's traffic (#591): its `traffic` seed
//                                                  ({summary, points}), else none
//   POST /__fake/apps {apps}                       test hook: replaces shop's apps [{id, slug, name,
//                                                  policy?, environments?, ingest?, sdk_stats?, status?,
//                                                  traffic?}], their policies, reports, health counters,
//                                                  SDK status and traffic
//   GET|PUT /api/v1/projects/shop/privacy-policy   shop's server-side deny list (#599): only the defaults
//                                                  until saved; PUT answers 403 without project.update and
//                                                  invalid_request naming a pattern JavaScript cannot compile
//   POST /__fake/privacy {}                        test hook: forgets shop's saved deny list
//   GET|POST /api/v1/projects/shop/alerts/health-checks, DELETE .../{id}, GET .../{id}/events
//                                                  shop's health checks and their failures (#608): none
//                                                  unless seeded; POST answers 422 for a private address
//   POST /__fake/health-checks {checks, events?}   test hook: replaces shop's health checks and, by
//                                                  check id, their failures
//   POST /__fake/handoff {next, role?, totp_secret?, backup_codes?, passkeys?, capabilities?, api_keys?, sso?, stale?, extra?}
//                                                  `extra: {members?, invitations?, sessions?}` adds that many
//                                                  numbered @example.com rows to each list (paging tests);
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
  const all = ["project.read", "project.update", "project.delete", "api_keys.create", "api_keys.revoke", "capture.manage", "alerts.manage", "members.invite", "members.remove", "billing.manage"];
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
/** Projects whose `GET /requests/timeline` alone answers 503, set by `/__fake/timeline-down` (#587). */
const timelineDown = new Set<string>();
/** Project slug → the rows `GET /api/v1/requests` answers instead, as seeded by `/__fake/requests` (#585). */
const requestsSeed = new Map<string, Record<string, unknown>[]>();
/** Project slug → the deploys `GET /deploys/changes` answers, as seeded by `/__fake/deploys` (#597). */
const deployChanges = new Map<string, Record<string, unknown>[]>();
/** Project slug → environment ("" for all) → what the traffic reads answer (#592), as seeded by `/__fake/traffic`. */
type TrafficSeed = { summary: Record<string, unknown>; points: unknown[]; endpoints: unknown[] };
const trafficSeed = new Map<string, Record<string, TrafficSeed>>();
/** "<project> <METHOD> <path>" → tab → what that endpoint read answers (#593), as seeded by `/__fake/endpoint`. */
const endpointSeed = new Map<string, Record<string, unknown>>();
/** Every endpoint read since the last seed, oldest first (#593). */
const endpointReads: { tab: string; method: string; path: string; query: Record<string, string> }[] = [];
/** "<app id> <METHOD> <path>" → the saved settings of that endpoint (#593). */
const endpointSettings = new Map<string, Record<string, unknown>>();
/** Project slug → the response-time report and raw response times of `/traffic/latency` (#595). */
const performanceSeed = new Map<string, { latency: Record<string, unknown>; samples: number[]; endpoints?: unknown[]; down: boolean }>();
/** App id → its saved response time threshold in ms (#595); absent means the default. */
const appThresholds = new Map<string, number>();
/** An error row the errors dashboard reads count (#594): `count` responses in bucket `bucket`. */
type ErrorRow = {
  method: string;
  path: string;
  status_code: number;
  bucket: number;
  count: number;
  consumer_id?: string;
  consumer_name?: string;
  validation_errors?: number;
  exceptions?: number;
};
/** Project slug → what the errors dashboard reads count (#594), as seeded by `/__fake/errors`. */
const errorsSeed = new Map<string, { buckets: string[]; requests: number[]; rows: ErrorRow[]; down: boolean }>();

/** Forgets the saved settings of one endpoint in every app. */
function forgetSettings(method: string, path: string) {
  for (const key of [...endpointSettings.keys()]) {
    const [, m, ...rest] = key.split(" ");
    if (m === method && rest.join(" ") === path) endpointSettings.delete(key);
  }
}

/** Whether an endpoint's saved settings in any app mark `code` as expected (#593, #594). */
function expectedFor(method: string, path: string, code: number): boolean {
  for (const [key, saved] of endpointSettings) {
    const [, m, ...rest] = key.split(" ");
    if (m === method && rest.join(" ") === path && ((saved.expected_status_codes as number[] | undefined) ?? []).includes(code)) return true;
  }
  return false;
}
/** Project slug → what the consumers reads answer (#596), as seeded by `/__fake/consumers`. */
const consumersSeed = new Map<
  string,
  { summary: unknown; points: unknown[]; consumers: Record<string, unknown>[]; details: Record<string, Record<string, unknown>> }
>();
/** shop's consumer groups and which group each consumer is in (#596): a consumer is in at most one. */
let consumerGroups: { id: string; name: string; created_at: string; updated_at: string }[] = [];
const consumerAssignments = new Map<string, string>();
const groupRef = (consumer: string) => {
  const g = consumerGroups.find((x) => x.id === consumerAssignments.get(consumer));
  return g ? { id: g.id, name: g.name } : undefined;
};
const groupOut = (g: (typeof consumerGroups)[number]) => ({ ...g, consumers: [...consumerAssignments.values()].filter((id) => id === g.id).length });

/** shop's saved views (#578, #589): shared ones for everyone, private ones for their creator. */
interface FakeView {
  id: string;
  name: string;
  surface: string;
  filter: Record<string, unknown>;
  shared: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}
let savedViews: FakeView[] = [];
/** Saved view writes answer 503 while set (`/__fake/views`), so the UI's undo shows. */
let savedViewWritesDown = false;

/** shop's apps (#598), their saved capture policies and what their SDKs reported, by app id. */
const DEFAULT_APP = { id: "5d0c1b2a-3e4f-4a5b-8c6d-7e8f9a0b1c2d", slug: PROJECT, name: "Shop" };
let shopApps: { id: string; slug: string; name: string }[] = [DEFAULT_APP];
const capturePolicies = new Map<string, Record<string, unknown>>();
const appReports = new Map<string, Record<string, unknown>[]>();
/** Ingest health (#602): seeded edge counters per day, newest last ("off": 503), and SDK counters. */
const appIngest = new Map<string, Record<string, unknown>[] | "off">();
const appSdkStats = new Map<string, Record<string, unknown>>();
/** The Apps overview (#591): each app's SDK status and its traffic ({summary, points}), by app id. */
const appStatuses = new Map<string, Record<string, unknown>>();
const appTraffic = new Map<string, { summary?: Record<string, unknown>; points?: unknown[] }>();

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
/** shop's health checks (#608) and their failures by check id, newest first. */
let healthChecks: Record<string, unknown>[] = [];
let healthCheckEvents: Record<string, Record<string, unknown>[]> = {};

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
  /** Extra rows for paging tests: that many more members, pending invitations and other sessions. */
  extra?: { members?: number; invitations?: number; sessions?: number };
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
      projects: o.projects.map((p) => ({ id: `prj_${p}`, slug: p, name: p, environments: ["production"], app_count: 1 })),
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

/** `extra` of the handoff: numbered @example.com members, invitations and older sessions (at most 500 each). */
function seedExtra(id: string, extra: Seeds["extra"]) {
  const n = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? Math.min(v, 500) : 0);
  const pad = (i: number) => String(i).padStart(3, "0");
  const members = membersByUser.get(id) ?? [];
  for (let i = 1; i <= n(extra?.members); i++) {
    members.push({ user: { id: randomUUID(), email: `teammate${pad(i)}@example.com`, name: `Teammate ${pad(i)}`, avatar_url: "" }, role: i % 5 === 0 ? "viewer" : "member", joined_at: ago(i), last_login_at: null });
  }
  membersByUser.set(id, members.sort((a, b) => a.joined_at.localeCompare(b.joined_at)));
  const invitations = invitationsByUser.get(id) ?? [];
  for (let i = 1; i <= n(extra?.invitations); i++) {
    invitations.push({ id: randomUUID(), email: `invitee${pad(i)}@example.com`, role: "member", created_at: ago(60 + i), expires_at: new Date(Date.now() - (60 + i) * 60_000 + INVITE_TTL_MS).toISOString(), resent_at: null });
  }
  invitationsByUser.set(id, invitations);
  const sessions = sessionsByUser.get(id) ?? [];
  const expires = new Date(Date.now() + 30 * 24 * 3600_000).toISOString();
  for (let i = 1; i <= n(extra?.sessions); i++) {
    sessions.push({ id: randomUUID(), access: null, device_label: `Device ${pad(i)}`, user_agent: `Device ${pad(i)} (fake)`, ip: "192.0.2.1", amr: ["email"], created_at: ago(24 * 60 + i), last_seen_at: ago(60 + i), expires_at: expires });
  }
  sessionsByUser.set(id, sessions);
}

/** The user's actions on shop: seeded ones, else what their role allows. */
const capabilitiesOf = (id: string): string[] => capabilities.get(id) ?? capabilitiesFor(roleOf(id));

function bundle(next: string, seeds: Seeds = {}, role: Role = "owner") {
  const id = randomUUID();
  const access = `at_${token()}`;
  seedSessions(id, access);
  seedMembers(id, role);
  seedInvitations(id);
  seedExtra(id, seeds.extra);
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
  projects: [{ id: "prj_globex", slug: "storefront", name: "storefront", environments: ["production"], app_count: 1 }],
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
    .map(({ id: pid, slug, name, environments }) => ({ id: pid, slug, name, environments, app_count: 1 }));
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
        projects: [{ id: "prj_fake", slug: "shop", name: "shop", environments: ["production"], app_count: shopApps.length }, ...createdProjectsOf(id, "acme")],
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
  if (req.method === "POST" && path === "/__fake/health-checks") {
    const body = await readBody(req);
    healthChecks = (body.checks as Record<string, unknown>[] | undefined) ?? [];
    healthCheckEvents = (body.events as Record<string, Record<string, unknown>[]> | undefined) ?? {};
    return send(res, 204);
  }
  // shop's health checks (#608). Like the API: another project answers forbidden and a URL to a
  // private address answers 422 with the API's detail.
  const hcPath = path.match(/^\/api\/v1\/projects\/([^/]+)\/alerts\/health-checks(?:\/([^/]+)(\/events)?)?$/);
  if (hcPath) {
    const user = signedInUser(req);
    if (!user) return problem(res, 401, "unauthenticated");
    if (decodeURIComponent(hcPath[1]) !== PROJECT) return problem(res, 403, "forbidden");
    const id = hcPath[2] ? decodeURIComponent(hcPath[2]) : null;
    if (!id && req.method === "GET") return send(res, 200, { health_checks: healthChecks });
    if (!id && req.method === "POST") {
      const body = await readBody(req);
      const host = (() => {
        try {
          return new URL(String(body.url)).hostname;
        } catch {
          return "";
        }
      })();
      if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.)/.test(host)) {
        return send(res, 422, { status: 422, title: "Unprocessable Entity", detail: "url must point to a public address" }, "application/problem+json");
      }
      const now = new Date().toISOString();
      const check = {
        id: randomUUID(), app_id: body.app_id, environment: body.environment, url: body.url, expected_status: body.expected_status ?? 200,
        enabled: true, status: "up", status_since: now, checked_at: null, created_by: null, created_at: now, updated_at: now,
      };
      healthChecks.push(check);
      return send(res, 201, check);
    }
    const found = healthChecks.find((c) => c.id === id);
    if (!found) return problem(res, 404, "not_found");
    if (hcPath[3] && req.method === "GET") return send(res, 200, { events: healthCheckEvents[id as string] ?? [] });
    if (!hcPath[3] && req.method === "DELETE") {
      healthChecks = healthChecks.filter((c) => c.id !== id);
      return send(res, 204);
    }
    return problem(res, 404, "not_found");
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
  // An app's ingest health (#602): the edge's counters per UTC day and its status's SDK counters.
  const healthPath = path.match(/^\/api\/v1\/apps\/([^/]+)\/(ingest-stats|status)$/);
  if (healthPath && req.method === "GET") {
    const user = signedInUser(req);
    if (!user) return problem(res, 401, "unauthenticated");
    if (url.searchParams.get("project") !== PROJECT) return problem(res, 404, "not_found");
    const app = shopApps.find((a) => a.id === decodeURIComponent(healthPath[1]));
    if (!app) return problem(res, 404, "not_found");
    if (healthPath[2] === "ingest-stats") {
      const seeded = appIngest.get(app.id) ?? [];
      if (seeded === "off") return problem(res, 503, "unavailable");
      const days = Number(url.searchParams.get("days") ?? 7);
      const zero = { accepted: 0, rejected: 0, truncated: 0, masked: 0 };
      const keys = Object.keys(zero) as (keyof typeof zero)[];
      const daily = Array.from({ length: days }, (_, i) => {
        const date = new Date(Date.now() - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10);
        const fromEnd = days - 1 - i;
        const day = seeded[seeded.length - 1 - fromEnd];
        return { date, ...zero, ...(day ?? {}) };
      });
      const totals = Object.fromEntries(keys.map((k) => [k, daily.reduce((n, d) => n + Number(d[k]), 0)]));
      return send(res, 200, { app_id: app.id, app: app.slug, days, totals, daily });
    }
    if (queryDown.has(PROJECT)) return problem(res, 503, "unavailable");
    const stats = appSdkStats.get(app.id);
    return send(res, 200, {
      app_id: app.id,
      app: app.slug,
      status: stats ? "reporting" : "never",
      last_seen_at: stats ? new Date().toISOString() : null,
      environments: [],
      instances: [],
      sdks: [],
      sdk_stats: { instances: 0, queued_records: 0, sent_records: 0, failed_batches: 0, dropped_records: 0, drop_counts: {}, ...stats },
      ...appStatuses.get(app.id),
    });
  }
  if (req.method === "POST" && path === "/__fake/apps") {
    // Test hook: replaces shop's apps, their saved policies, their SDK reports and health counters.
    const { apps } = await readBody(req);
    const list = Array.isArray(apps) ? (apps as Record<string, unknown>[]) : [];
    capturePolicies.clear();
    appReports.clear();
    appIngest.clear();
    appSdkStats.clear();
    appStatuses.clear();
    appTraffic.clear();
    shopApps = list.length ? list.map((a) => ({ id: String(a.id ?? randomUUID()), slug: String(a.slug), name: String(a.name ?? a.slug) })) : [DEFAULT_APP];
    list.forEach((a, i) => {
      const id = shopApps[i].id;
      if (typeof a.policy === "object" && a.policy !== null) capturePolicies.set(id, a.policy as Record<string, unknown>);
      if (Array.isArray(a.environments)) appReports.set(id, a.environments as Record<string, unknown>[]);
      if (a.ingest === "off" || Array.isArray(a.ingest)) appIngest.set(id, a.ingest as Record<string, unknown>[] | "off");
      if (typeof a.sdk_stats === "object" && a.sdk_stats !== null) appSdkStats.set(id, a.sdk_stats as Record<string, unknown>);
      if (typeof a.status === "object" && a.status !== null) appStatuses.set(id, a.status as Record<string, unknown>);
      if (typeof a.traffic === "object" && a.traffic !== null) appTraffic.set(id, a.traffic as { summary?: Record<string, unknown>; points?: unknown[] });
    });
    return send(res, 204);
  }
  // One app's traffic for the Apps overview (#591); same access rules as below.
  const appScoped = (path === "/api/v1/traffic/summary" || path === "/api/v1/traffic/timeseries") && url.searchParams.has("app");
  if (req.method === "GET" && appScoped) {
    const user = signedInUser(req);
    if (!user) return problem(res, 401, "unauthenticated");
    if (url.searchParams.get("project") !== PROJECT) return problem(res, 404, "not_found");
    if (queryDown.has(PROJECT)) return problem(res, 503, "unavailable");
    const range = url.searchParams.get("range") ?? "24h";
    const seed = appTraffic.get(url.searchParams.get("app") ?? "");
    if (path === "/api/v1/traffic/timeseries") return send(res, 200, { range, bucket_seconds: 1800, points: seed?.points ?? [] });
    const none = { requests: 0, client_errors: 0, server_errors: 0, error_rate: 0, p50_ms: 0, p95_ms: 0, p99_ms: 0, requests_per_minute: 0, apdex: null };
    return send(res, 200, { range, from: "", to: "", ...none, ...seed?.summary });
  }
  // The Performance page's endpoints read (#595, `limit=500`) answers the `/__fake/performance`
  // seed when it has endpoints, so its tests never share the Traffic tests' seed.
  if (req.method === "GET" && path === "/api/v1/traffic/endpoints" && url.searchParams.get("limit") === "500") {
    const slug = url.searchParams.get("project") ?? "";
    const endpoints = performanceSeed.get(slug)?.endpoints;
    const user = signedInUser(req);
    if (endpoints && user && slug === PROJECT) {
      if (queryDown.has(slug) || performanceSeed.get(slug)?.down) return problem(res, 503, "unavailable");
      return send(res, 200, { endpoints });
    }
  }
  // The traffic reads as seeded (#592), by environment; same access rules as below.
  if (req.method === "GET" && (path === "/api/v1/traffic/summary" || path === "/api/v1/traffic/endpoints" || path === "/api/v1/traffic/timeseries")) {
    const slug = url.searchParams.get("project") ?? "";
    const seeded = trafficSeed.get(slug);
    if (seeded || path === "/api/v1/traffic/timeseries") {
      const user = signedInUser(req);
      if (!user) return problem(res, 401, "unauthenticated");
      if (slug !== PROJECT && createdProjects.get(slug)?.owner !== user) return problem(res, 404, "not_found");
      if (queryDown.has(slug)) return problem(res, 503, "unavailable");
      const range = url.searchParams.get("range") ?? "24h";
      const env = url.searchParams.get("env") ?? "";
      const seed = seeded?.[env] ?? seeded?.[""];
      if (path === "/api/v1/traffic/timeseries") return send(res, 200, { range, bucket_seconds: 900, points: seed?.points ?? [] });
      if (path === "/api/v1/traffic/endpoints") {
        // Endpoints excluded from metrics (#600) leave the list, as the query role does.
        const excluded = (e: Record<string, unknown>) => shopApps.some((a) => endpointSettings.get(`${a.id} ${String(e.method).toUpperCase()} ${String(e.path)}`)?.excluded === true);
        return send(res, 200, { endpoints: ((seed?.endpoints ?? []) as Record<string, unknown>[]).filter((e) => !excluded(e)) });
      }
      return send(res, 200, { ...seed?.summary, range });
    }
  }
  if (req.method === "POST" && path === "/__fake/requests") {
    // Test hook: replaces what the request log reads answer for `project`.
    const b = await readBody(req);
    if (Array.isArray(b.rows)) requestsSeed.set(String(b.project), b.rows as Record<string, unknown>[]);
    else requestsSeed.delete(String(b.project));
    return send(res, 204);
  }
  if (req.method === "POST" && path === "/__fake/traffic") {
    // Test hook: replaces what the traffic reads answer for `project`, per environment.
    const b = await readBody(req);
    const envs = (b.envs as Record<string, TrafficSeed> | undefined) ?? {};
    if (Object.keys(envs).length) trafficSeed.set(String(b.project), envs);
    else trafficSeed.delete(String(b.project));
    return send(res, 204);
  }
  // One endpoint's detail reads (#593), as seeded; same access rules as the traffic reads. Every
  // read is logged, so a test can tell which tabs read their data.
  const endpointRead = path.match(/^\/api\/v1\/endpoints\/([^/]+)\/([^/]+)\/(requests|errors|latency|transfer)$/);
  if (req.method === "GET" && endpointRead) {
    const user = signedInUser(req);
    if (!user) return problem(res, 401, "unauthenticated");
    const slug = url.searchParams.get("project") ?? "";
    if (slug !== PROJECT && createdProjects.get(slug)?.owner !== user) return problem(res, 404, "not_found");
    const method = decodeURIComponent(endpointRead[1]).toUpperCase();
    const route = decodeURIComponent(endpointRead[2]);
    const tab = endpointRead[3];
    endpointReads.push({ tab, method, path: route, query: Object.fromEntries([...url.searchParams].filter(([k]) => k !== "project")) });
    if (queryDown.has(slug)) return problem(res, 503, "unavailable");
    const range = url.searchParams.get("range") ?? "24h";
    const seeded = endpointSeed.get(`${slug} ${method} ${route}`)?.[tab];
    const empty: Record<string, unknown> = {
      requests: { summary: { requests: 0, successful: 0, client_errors: 0, server_errors: 0, requests_per_minute: 0 }, points: [], consumers: [] },
      errors: { summary: { requests: 0, client_errors: 0, server_errors: 0, client_error_rate: 0, server_error_rate: 0 }, points: [], statuses: [], validation_errors: [], exceptions: [] },
      latency: { summary: { requests: 0, avg_ms: 0, max_ms: 0, p50_ms: 0, p75_ms: 0, p90_ms: 0, p95_ms: 0, p99_ms: 0, apdex: null }, points: [], histogram: [] },
      transfer: { summary: { requests: 0, request_bytes: 0, response_bytes: 0, avg_request_bytes: 0, avg_response_bytes: 0 }, points: [], request_size_histogram: [], response_size_histogram: [] },
    };
    return send(res, 200, { method, path: route, range, from: "", to: "", bucket_seconds: 900, ...(seeded ?? (empty[tab] as object)) });
  }
  if (req.method === "POST" && path === "/__fake/endpoint") {
    // Test hook: what one endpoint's reads answer, by tab; forgets the read log and its settings.
    const b = await readBody(req);
    const key = `${String(b.project)} ${String(b.method).toUpperCase()} ${String(b.path)}`;
    const tabs = (b.tabs as Record<string, unknown> | undefined) ?? {};
    if (Object.keys(tabs).length) endpointSeed.set(key, tabs);
    else endpointSeed.delete(key);
    endpointReads.length = 0;
    // Only this endpoint's settings: spec files run in parallel and others keep theirs (#594).
    forgetSettings(String(b.method).toUpperCase(), String(b.path));
    return send(res, 204);
  }
  if (req.method === "GET" && path === "/__fake/endpoint-reads") return send(res, 200, { reads: endpointReads });
  // An endpoint's settings for an app (#593): the defaults until saved; saving needs `capture.manage`.
  const settingsPath = path.match(/^\/api\/v1\/apps\/([^/]+)\/endpoints\/([^/]+)\/([^/]+)\/settings$/);
  if (settingsPath) {
    const user = signedInUser(req);
    if (!user) return problem(res, 401, "unauthenticated");
    const app = shopApps.find((a) => a.id === decodeURIComponent(settingsPath[1]));
    if (!app) return problem(res, 404, "not_found");
    const method = decodeURIComponent(settingsPath[2]).toUpperCase();
    const route = decodeURIComponent(settingsPath[3]);
    const key = `${app.id} ${method} ${route}`;
    const out = () => ({
      app_id: app.id,
      method,
      path: route,
      expected_status_codes: [],
      latency_threshold_ms: null,
      excluded: false,
      updated_at: null,
      updated_by: null,
      ...endpointSettings.get(key),
    });
    if (req.method === "GET") return send(res, 200, out());
    if (req.method === "PUT") {
      if (!capabilitiesOf(user).includes("capture.manage")) return problem(res, 403, "forbidden");
      const body = await readBody(req);
      const codes = body.expected_status_codes ?? [];
      const threshold = body.latency_threshold_ms ?? null;
      const valid =
        typeof body.excluded === "boolean" &&
        Array.isArray(codes) &&
        codes.length <= 32 &&
        codes.every((c) => Number.isInteger(c) && c >= 100 && c <= 599) &&
        (threshold === null || (Number.isInteger(threshold) && (threshold as number) >= 1 && (threshold as number) <= 600_000));
      if (!valid) return problem(res, 422, "validation_failed");
      endpointSettings.set(key, {
        expected_status_codes: [...new Set(codes as number[])].sort((a, b) => a - b),
        latency_threshold_ms: threshold,
        excluded: body.excluded,
        updated_at: new Date().toISOString(),
        updated_by: user,
      });
      return send(res, 200, out());
    }
    return problem(res, 404, "not_found");
  }
  // The Explore timeline (#587), as `GET /requests/timeline` answers it: the seeded rows inside the
  // window (the range ending now, narrowed by from/to) counted per bucket by status class. The
  // bucket width follows internal/query's steps (at most 100 bars). `/__fake/timeline-down` makes
  // it alone answer 503.
  if (req.method === "GET" && path === "/api/v1/requests/timeline") {
    const user = signedInUser(req);
    if (!user) return problem(res, 401, "unauthenticated");
    const slug = url.searchParams.get("project") ?? "";
    if (slug !== PROJECT && createdProjects.get(slug)?.owner !== user) return problem(res, 404, "not_found");
    if (queryDown.has(slug) || timelineDown.has(slug)) return problem(res, 503, "unavailable");
    const span = { "1h": 3600, "6h": 21600, "24h": 86400, "7d": 604800 }[url.searchParams.get("range") ?? "24h"] ?? 86400;
    const end = Math.floor(Date.now() / 60_000) * 60_000 + 60_000;
    let lo = end - span * 1000;
    let hi = end;
    const from = Date.parse(url.searchParams.get("from") ?? "");
    const to = Date.parse(url.searchParams.get("to") ?? "");
    if (!Number.isNaN(from) && !Number.isNaN(to) && from >= to) return problem(res, 422, "validation_failed");
    if (!Number.isNaN(from)) lo = Math.max(lo, from);
    if (!Number.isNaN(to)) hi = Math.min(hi, to);
    hi = Math.max(hi, lo);
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];
    const step = steps.find((s) => (hi - lo) / 1000 <= s * 100) ?? 86400;
    const status = (url.searchParams.get("status") ?? "").split(",").filter(Boolean);
    const method = (url.searchParams.get("method") ?? "").toUpperCase();
    const rows = (requestsSeed.get(slug) ?? []).filter((r) => {
      const t = Date.parse(String(r.timestamp));
      return (
        t >= lo &&
        t < hi &&
        (!method || r.method === method) &&
        (!status.length || status.some((s) => (/^[1-5]xx$/.test(s) ? String(r.status_code)[0] === s[0] : String(r.status_code) === s)))
      );
    });
    const buckets = [];
    for (let t = Math.floor(lo / 1000 / step) * step * 1000; t < hi; t += step * 1000) {
      const inside = rows.filter((r) => {
        const ts = Date.parse(String(r.timestamp));
        return ts >= t && ts < t + step * 1000;
      });
      const code = (r: Record<string, unknown>) => Number(r.status_code);
      buckets.push({
        ts: new Date(t).toISOString(),
        requests: inside.length,
        successful: inside.filter((r) => code(r) < 400).length,
        client_errors: inside.filter((r) => code(r) >= 400 && code(r) < 500).length,
        server_errors: inside.filter((r) => code(r) >= 500).length,
      });
    }
    return send(res, 200, { from: new Date(lo).toISOString(), to: new Date(hi).toISOString(), bucket_seconds: step, buckets });
  }
  // One request of the log (#588), as `GET /requests/{id}` answers it: the seeded row with that id
  // plus what its `detail` seeds (headers, bodies, validation errors, spans and logs).
  const requestDetail = path.match(/^\/api\/v1\/requests\/([^/]+)$/);
  if (req.method === "GET" && requestDetail) {
    const user = signedInUser(req);
    if (!user) return problem(res, 401, "unauthenticated");
    const slug = url.searchParams.get("project") ?? "";
    if (slug !== PROJECT && createdProjects.get(slug)?.owner !== user) return problem(res, 404, "not_found");
    if (queryDown.has(slug)) return problem(res, 503, "unavailable");
    const id = decodeURIComponent(requestDetail[1]);
    const found = (requestsSeed.get(slug) ?? []).find((r) => r.id === id);
    if (!found) return problem(res, 404, "not_found");
    const { detail, ...row } = found as Record<string, unknown> & { detail?: { request?: Record<string, unknown>; spans?: unknown[]; logs?: unknown[] } };
    const request = {
      span_id: "",
      user_agent: "",
      base_url: "",
      release: "",
      commit: "",
      request_headers: "",
      response_headers: "",
      request_body: "",
      response_body: "",
      attributes: {},
      validation_errors: [],
      ...row,
      ...detail?.request,
    };
    return send(res, 200, { request, spans: detail?.spans ?? [], logs: detail?.logs ?? [] });
  }
  // The errors dashboard (#594) over the seeded rows; same access rules as the traffic reads.
  // Expected status codes of an endpoint are left out, as internal/query/error_status.go does.
  const errorsStatus = path.match(/^\/api\/v1\/errors\/status(?:\/(\d{3}))?$/);
  if (req.method === "GET" && (errorsStatus || path === "/api/v1/errors")) {
    const user = signedInUser(req);
    if (!user) return problem(res, 401, "unauthenticated");
    const slug = url.searchParams.get("project") ?? "";
    if (slug !== PROJECT && createdProjects.get(slug)?.owner !== user) return problem(res, 404, "not_found");
    const seed = errorsSeed.get(slug) ?? { buckets: [], requests: [], rows: [], down: false };
    // Only its own `down` seed: `/__fake/query-down` is shared with spec files running in parallel.
    if (seed.down) return problem(res, 503, "unavailable");
    const range = url.searchParams.get("range") ?? "24h";
    const rows = seed.rows.filter((r) => !expectedFor(r.method, r.path, r.status_code));
    const requests = seed.requests.reduce((a, b) => a + b, 0);
    const lastSeen = (list: ErrorRow[]) => seed.buckets[Math.max(...list.map((r) => r.bucket))] ?? "";
    const firstSeen = (list: ErrorRow[]) => seed.buckets[Math.min(...list.map((r) => r.bucket))] ?? "";
    const sum = (list: ErrorRow[], f: (r: ErrorRow) => number = (r) => r.count) => list.reduce((a, r) => a + f(r), 0);
    const consumers = (list: ErrorRow[]) => new Set(list.filter((r) => r.consumer_id).map((r) => r.consumer_id)).size;
    const groupBy = <K,>(list: ErrorRow[], key: (r: ErrorRow) => K) => {
      const out = new Map<K, ErrorRow[]>();
      for (const r of list) out.set(key(r), [...(out.get(key(r)) ?? []), r]);
      return [...out.entries()];
    };
    const split = (n: number, list: ErrorRow[]) => {
      const client = sum(list.filter((r) => r.status_code < 500));
      const server = sum(list.filter((r) => r.status_code >= 500));
      return { requests: n, client_errors: client, server_errors: server, client_error_rate: n ? client / n : 0, server_error_rate: n ? server / n : 0 };
    };
    if (path === "/api/v1/errors") {
      const groups = groupBy(rows, (r) => `${r.method} ${r.path} ${r.status_code}`).map(([, list]) => ({
        method: list[0].method,
        path: list[0].path,
        status_code: list[0].status_code,
        count: sum(list),
        consumers: consumers(list),
        last_seen: lastSeen(list),
      }));
      return send(res, 200, { errors: groups.sort((a, b) => b.count - a.count) });
    }
    const frame = { range, from: seed.buckets[0] ?? "", to: "", bucket_seconds: 900 };
    if (errorsStatus && !errorsStatus[1]) {
      const statuses = groupBy(rows, (r) => r.status_code)
        .map(([code, list]) => ({
          status_code: code,
          count: sum(list),
          share: requests ? sum(list) / requests : 0,
          endpoints: new Set(list.map((r) => `${r.method} ${r.path}`)).size,
          consumers: consumers(list),
          first_seen: firstSeen(list),
          last_seen: lastSeen(list),
        }))
        .sort((a, b) => b.count - a.count || a.status_code - b.status_code);
      return send(res, 200, {
        ...frame,
        summary: split(requests, rows),
        points: seed.buckets.map((ts, i) => ({ ts, ...split(seed.requests[i] ?? 0, rows.filter((r) => r.bucket === i)) })),
        series: statuses.map((st) => ({ status_code: st.status_code, counts: seed.buckets.map((_, i) => sum(rows.filter((r) => r.bucket === i && r.status_code === st.status_code))) })),
        statuses,
      });
    }
    const code = Number(errorsStatus?.[1]);
    if (code < 400 || code > 599) return problem(res, 422, "validation_failed");
    const match = rows.filter((r) => r.status_code === code);
    const occurrences = sum(match);
    const hours = { "1h": 1, "6h": 6, "24h": 24, "7d": 168 }[range] ?? 24;
    return send(res, 200, {
      ...frame,
      status_code: code,
      occurrences,
      requests,
      share: requests ? occurrences / requests : 0,
      per_hour: occurrences / hours,
      consumers: consumers(match),
      anonymous: sum(match.filter((r) => !r.consumer_id)),
      endpoints: new Set(match.map((r) => `${r.method} ${r.path}`)).size,
      first_seen: occurrences ? firstSeen(match) : null,
      last_seen: occurrences ? lastSeen(match) : null,
      points: seed.buckets.map((ts, i) => ({ ts, count: sum(match.filter((r) => r.bucket === i)) })),
      endpoint_breakdown: groupBy(match, (r) => `${r.method} ${r.path}`)
        .map(([, list]) => ({
          method: list[0].method,
          path: list[0].path,
          count: sum(list),
          consumers: consumers(list),
          last_seen: lastSeen(list),
          validation_errors: sum(list, (r) => r.validation_errors ?? 0),
          exceptions: sum(list, (r) => r.exceptions ?? 0),
        }))
        .sort((a, b) => b.count - a.count),
      consumer_breakdown: groupBy(
        match.filter((r) => r.consumer_id),
        (r) => r.consumer_id,
      )
        .map(([id, list]) => ({
          consumer_id: id,
          consumer_name: list[list.length - 1].consumer_name ?? "",
          count: sum(list),
          share: occurrences ? sum(list) / occurrences : 0,
          first_seen: firstSeen(list),
          last_seen: lastSeen(list),
        }))
        .sort((a, b) => b.count - a.count),
    });
  }
  if (req.method === "POST" && path === "/__fake/errors") {
    // Test hook: what the errors dashboard reads count for `project`; forgets the settings of its endpoints.
    const b = await readBody(req);
    errorsSeed.set(String(b.project), {
      buckets: (b.buckets as string[] | undefined) ?? [],
      requests: (b.requests as number[] | undefined) ?? [],
      rows: (b.rows as ErrorRow[] | undefined) ?? [],
      down: b.down === true,
    });
    for (const r of (b.rows as ErrorRow[] | undefined) ?? []) forgetSettings(r.method, r.path);
    return send(res, 204);
  }
  // The Performance page's report (#595): the seed, its Apdex scored like internal/query does
  // (satisfied <= T, tolerating <= 4T) over the seeded response times against the threshold of
  // shop's first app, so a saved threshold changes what the next read answers.
  if (req.method === "GET" && path === "/api/v1/traffic/latency") {
    const user = signedInUser(req);
    if (!user) return problem(res, 401, "unauthenticated");
    const slug = url.searchParams.get("project") ?? "";
    if (slug !== PROJECT && createdProjects.get(slug)?.owner !== user) return problem(res, 404, "not_found");
    const seed = performanceSeed.get(slug);
    if (queryDown.has(slug) || seed?.down) return problem(res, 503, "unavailable");
    const range = url.searchParams.get("range") ?? "24h";
    const empty = { requests: 0, avg_ms: 0, max_ms: 0, p50_ms: 0, p75_ms: 0, p90_ms: 0, p95_ms: 0, p99_ms: 0, apdex: null };
    const latency = seed?.latency ?? { summary: empty, points: [], histogram: [] };
    const t = appThresholds.get(shopApps[0]?.id ?? "") ?? 500;
    const samples = seed?.samples ?? [];
    const satisfied = samples.filter((ms) => ms <= t).length;
    const tolerating = samples.filter((ms) => ms > t && ms <= 4 * t).length;
    const apdex = samples.length ? Math.round(((satisfied + tolerating / 2) / samples.length) * 100) / 100 : null;
    const summary = { ...empty, ...(latency.summary as Record<string, unknown>), apdex };
    return send(res, 200, { range, from: "", to: "", bucket_seconds: 900, ...latency, summary });
  }
  if (req.method === "POST" && path === "/__fake/performance") {
    // Test hook: what the Performance report answers for `project`; forgets the app thresholds.
    const b = await readBody(req);
    if (b.latency) {
      performanceSeed.set(String(b.project), {
        latency: b.latency as Record<string, unknown>,
        samples: Array.isArray(b.samples_ms) ? (b.samples_ms as number[]) : [],
        endpoints: Array.isArray(b.endpoints) ? b.endpoints : undefined,
        down: b.down === true,
      });
    } else performanceSeed.delete(String(b.project));
    appThresholds.clear();
    return send(res, 204);
  }
  // An app's response time threshold (#595): null until saved; saving needs `capture.manage`.
  const appSettingsPath = path.match(/^\/api\/v1\/apps\/([^/]+)\/settings$/);
  if (appSettingsPath) {
    const user = signedInUser(req);
    if (!user) return problem(res, 401, "unauthenticated");
    const app = shopApps.find((a) => a.id === decodeURIComponent(appSettingsPath[1]));
    if (!app) return problem(res, 404, "not_found");
    const out = () => {
      const ms = appThresholds.get(app.id) ?? null;
      return { app_id: app.id, latency_threshold_ms: ms, apdex_threshold_ms: ms ?? 500 };
    };
    if (req.method === "GET") return send(res, 200, out());
    if (req.method === "PUT") {
      if (!capabilitiesOf(user).includes("capture.manage")) return problem(res, 403, "forbidden");
      const body = await readBody(req);
      const ms = body.latency_threshold_ms ?? null;
      if (ms !== null && !(Number.isInteger(ms) && (ms as number) >= 1 && (ms as number) <= 600_000)) return problem(res, 422, "validation_failed");
      if (ms === null) appThresholds.delete(app.id);
      else appThresholds.set(app.id, ms as number);
      return send(res, 200, out());
    }
    return problem(res, 404, "not_found");
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
      const seeded = requestsSeed.get(slug);
      if (seeded) {
        // The Explore filters (#586): method, path and status (codes and classes) narrow the seed.
        const method = (url.searchParams.get("method") ?? "").toUpperCase();
        const route = url.searchParams.get("path") ?? "";
        const status = (url.searchParams.get("status") ?? "").split(",").filter(Boolean);
        // The timeline's zoom and jump point (#587): from (inclusive) and to (exclusive).
        const from = Date.parse(url.searchParams.get("from") ?? "");
        const to = Date.parse(url.searchParams.get("to") ?? "");
        const matches = (r: Record<string, unknown>) =>
          (Number.isNaN(from) || Date.parse(String(r.timestamp)) >= from) &&
          (Number.isNaN(to) || Date.parse(String(r.timestamp)) < to) &&
          (!method || r.method === method) &&
          (!route || r.path === route) &&
          (!status.length || status.some((t) => (/^[1-5]xx$/.test(t) ? String(r.status_code)[0] === t[0] : String(r.status_code) === t)));
        // A row's `detail` seeds the request drawer (#588); the log does not carry it.
        const listed = seeded.filter(matches).map(({ detail: _detail, ...r }) => r);
        return send(res, 200, { requests: listed.slice(0, limit), next_cursor: "" });
      }
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
    const all = (deployChanges.get(slug) ?? []).map((d, i) => ({ id: (i + 1).toString(16).padStart(16, "a"), ...(d as object) }));
    const offset = Number(url.searchParams.get("offset") ?? 0) || 0;
    const limit = Number(url.searchParams.get("limit") ?? 25) || 25;
    return send(res, 200, { window_minutes: 60, total: all.length, deploys: all.slice(offset, offset + limit) });
  }
  // Consumers (#596), as seeded, each with the SDK group it was seeded with (consumer_group); same
  // access rules as above. The list and the group roll-up search, sort and page like the API.
  const consumerPath = path.match(/^\/api\/v1\/(consumers|consumer-groups)(?:\/([^/]+))?$/);
  if (req.method === "GET" && consumerPath && !(consumerPath[1] === "consumer-groups" && consumerPath[2] !== undefined)) {
    const user = signedInUser(req);
    if (!user) return problem(res, 401, "unauthenticated");
    const slug = url.searchParams.get("project") ?? "";
    if (slug !== PROJECT && createdProjects.get(slug)?.owner !== user) return problem(res, 404, "not_found");
    if (queryDown.has(slug)) return problem(res, 503, "unavailable");
    const seed = consumersSeed.get(slug) ?? { summary: { consumers: 0, new: 0, returning: 0 }, points: [], consumers: [], details: {} };
    const range = url.searchParams.get("range") ?? "24h";
    const num = (k: string, d: number) => Number(url.searchParams.get(k) ?? d);
    const limit = num("limit", consumerPath[1] === "consumers" && consumerPath[2] !== undefined ? 50 : 100);
    const offset = num("offset", 0);
    const search = (url.searchParams.get("search") ?? "").toLowerCase();
    const sort = url.searchParams.get("sort") ?? "requests";
    const n = (r: Record<string, unknown>, k: string) => Number(r[k] ?? 0);
    const order = (rows: Record<string, unknown>[]) =>
      [...rows].sort((x, y) =>
        sort === "errors"
          ? n(y, "client_errors") + n(y, "server_errors") - (n(x, "client_errors") + n(x, "server_errors")) || n(y, "requests") - n(x, "requests")
          : sort === "last_seen"
            ? String(y.last_seen).localeCompare(String(x.last_seen))
            : sort === "consumers"
              ? n(y, "consumers") - n(x, "consumers") || n(y, "requests") - n(x, "requests")
              : n(y, "requests") - n(x, "requests"),
      );
    const page = <T,>(rows: T[]) => rows.slice(offset, offset + limit);
    if (consumerPath[1] === "consumer-groups") {
      const by = new Map<string, Record<string, unknown>>();
      for (const c of seed.consumers) {
        const g = String(c.consumer_group ?? "");
        if (!g || (search && !g.toLowerCase().includes(search))) continue;
        const cur = by.get(g) ?? { group: g, consumers: 0, requests: 0, successful: 0, client_errors: 0, server_errors: 0, last_seen: "", sparkline: [] as number[] };
        for (const k of ["requests", "successful", "client_errors", "server_errors"]) cur[k] = n(cur, k) + n(c, k);
        cur.consumers = n(cur, "consumers") + 1;
        if (String(c.last_seen) > String(cur.last_seen)) cur.last_seen = c.last_seen;
        cur.sparkline = ((c.sparkline as number[]) ?? []).map((v, i) => v + ((cur.sparkline as number[])[i] ?? 0));
        by.set(g, cur);
      }
      const all = order([...by.values()]);
      return send(res, 200, { range, from: "2026-11-05T10:00:00Z", to: "", bucket_seconds: 900, total: all.length, groups: page(all) });
    }
    if (consumerPath[2] !== undefined) {
      const id = decodeURIComponent(consumerPath[2]);
      const detail = seed.details[id];
      if (!detail) return problem(res, 404, "not_found");
      const recent = (k: string) => page((detail[k] as unknown[]) ?? []);
      return send(res, 200, { top_endpoints: [], ...detail, consumer_id: id, range, recent_requests: recent("recent_requests"), recent_errors: recent("recent_errors") });
    }
    const group = url.searchParams.get("group");
    const inGroup = seed.consumers.filter((c) => !group || c.consumer_group === group);
    const matched = order(inGroup.filter((c) => !search || String(c.consumer_id).toLowerCase().includes(search) || String(c.consumer_name).toLowerCase().includes(search)));
    const totals = { requests: 0, successful: 0, client_errors: 0, server_errors: 0 };
    for (const c of inGroup) for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += n(c, k);
    const summary = group ? { consumers: inGroup.length, new: inGroup.filter((c) => c.new).length, returning: inGroup.filter((c) => !c.new).length } : seed.summary;
    return send(res, 200, { range, from: "2026-11-05T10:00:00Z", to: "", bucket_seconds: 900, summary, totals, points: seed.points, total: matched.length, consumers: page(matched) });
  }
  if (req.method === "POST" && path === "/__fake/consumers") {
    // Test hook: replaces what the consumers reads answer for `project`, and shop's dashboard groups
    // (deprecated; the alert rule editor still lists them).
    const b = await readBody(req);
    consumersSeed.set(String(b.project), {
      summary: b.summary ?? { consumers: 0, new: 0, returning: 0 },
      points: Array.isArray(b.points) ? b.points : [],
      consumers: Array.isArray(b.consumers) ? (b.consumers as Record<string, unknown>[]) : [],
      details: (b.details as Record<string, Record<string, unknown>>) ?? {},
    });
    const at = new Date().toISOString();
    consumerGroups = Array.isArray(b.groups) ? (b.groups as { id: string; name: string }[]).map((g) => ({ id: g.id, name: g.name, created_at: at, updated_at: at })) : [];
    consumerAssignments.clear();
    for (const [c, g] of Object.entries((b.assignments as Record<string, string>) ?? {})) consumerAssignments.set(c, g);
    return send(res, 204);
  }
  if (req.method === "POST" && path === "/__fake/views") {
    // Test hook: replaces shop's saved views ({views?: [{id?, name, surface?, filter?, shared?, created_by?}]})
    // and whether their writes answer 503 (`down`).
    const b = await readBody(req);
    const at = new Date().toISOString();
    savedViews = Array.isArray(b.views)
      ? (b.views as Partial<FakeView>[]).map((v) => ({
          id: v.id ?? randomUUID(),
          name: String(v.name ?? ""),
          surface: v.surface ?? "explore",
          filter: v.filter ?? {},
          shared: v.shared === true,
          created_by: v.created_by ?? null,
          created_at: at,
          updated_at: at,
        }))
      : [];
    savedViewWritesDown = b.down === true;
    return send(res, 204);
  }
  const viewsPath = path.match(/^\/api\/v1\/projects\/([^/]+)\/views(?:\/([^/]+))?$/);
  if (viewsPath) {
    // Saved views (#578), as internal/query/saved_views.go answers them.
    const user = signedInUser(req);
    if (!user) return problem(res, 401, "unauthenticated");
    if (decodeURIComponent(viewsPath[1]) !== PROJECT) return problem(res, 404, "not_found");
    const visible = (v: FakeView) => v.shared || v.created_by === user;
    const viewId = viewsPath[2] === undefined ? undefined : decodeURIComponent(viewsPath[2]);
    if (req.method === "GET" && viewId === undefined) {
      const surface = url.searchParams.get("surface");
      const views = savedViews
        .filter((v) => visible(v) && (!surface || v.surface === surface))
        .sort((a, b) => a.surface.localeCompare(b.surface) || a.name.localeCompare(b.name));
      return send(res, 200, { views });
    }
    if (savedViewWritesDown && req.method !== "GET") return problem(res, 503, "unavailable");
    const body = req.method === "POST" || req.method === "PUT" ? await readBody(req) : {};
    const name = String(body.name ?? "").trim();
    const filter = typeof body.filter === "object" && body.filter !== null && !Array.isArray(body.filter) ? (body.filter as Record<string, unknown>) : {};
    const taken = (creator: string | null, surface: string, except?: string) =>
      savedViews.some((v) => v.id !== except && v.created_by === creator && v.surface === surface && v.name === name);
    if (viewId === undefined) {
      if (req.method !== "POST") return problem(res, 404, "not_found");
      const surface = String(body.surface ?? "");
      if (name === "" || [...name].length > 128 || !["explore", "endpoints", "errors", "performance", "consumers", "apps"].includes(surface)) return problem(res, 422, "validation_failed");
      if (taken(user, surface)) return problem(res, 409, "conflict");
      const at = new Date().toISOString();
      const v: FakeView = { id: randomUUID(), name, surface, filter, shared: body.shared === true, created_by: user, created_at: at, updated_at: at };
      savedViews.push(v);
      return send(res, 201, v);
    }
    const v = savedViews.find((x) => x.id === viewId);
    if (!v || !visible(v)) return problem(res, 404, "not_found");
    if (req.method === "GET") return send(res, 200, v);
    if (v.created_by !== user && !capabilitiesOf(user).includes("capture.manage")) return problem(res, 403, "forbidden");
    if (req.method === "DELETE") {
      savedViews = savedViews.filter((x) => x !== v);
      return send(res, 204);
    }
    if (req.method !== "PUT") return problem(res, 404, "not_found");
    if (name === "" || [...name].length > 128) return problem(res, 422, "validation_failed");
    if (taken(v.created_by, v.surface, v.id)) return problem(res, 409, "conflict");
    Object.assign(v, { name, filter, shared: body.shared === true, updated_at: new Date().toISOString() });
    return send(res, 200, v);
  }
  const groupsPath = path.match(/^\/api\/v1\/projects\/([^/]+)\/(?:consumer-groups(?:\/([^/]+))?|consumers\/([^/]+)\/group)$/);
  if (groupsPath) {
    const user = signedInUser(req);
    if (!user) return problem(res, 401, "unauthenticated");
    if (decodeURIComponent(groupsPath[1]) !== PROJECT) return problem(res, 404, "not_found");
    const [, , groupId, consumerId] = groupsPath;
    if (req.method === "GET" && groupId === undefined && consumerId === undefined) {
      return send(res, 200, { groups: [...consumerGroups].sort((a, b) => a.name.localeCompare(b.name)).map(groupOut) });
    }
    if (!capabilitiesOf(user).includes("project.update")) return problem(res, 403, "forbidden");
    const nameOf = async () => String((await readBody(req)).name ?? "").trim();
    const taken = (name: string, except?: string) => consumerGroups.some((g) => g.id !== except && g.name.toLowerCase() === name.toLowerCase());
    if (consumerId !== undefined) {
      const consumer = decodeURIComponent(consumerId);
      if (req.method === "DELETE") {
        if (!consumerAssignments.delete(consumer)) return problem(res, 404, "not_found");
        return send(res, 204);
      }
      if (req.method !== "PUT") return problem(res, 404, "not_found");
      const target = String((await readBody(req)).group_id ?? "");
      const g = consumerGroups.find((x) => x.id === target);
      if (!g) return problem(res, 404, "not_found");
      consumerAssignments.set(consumer, g.id);
      return send(res, 200, { consumer_id: consumer, group: { id: g.id, name: g.name }, assigned_at: new Date().toISOString() });
    }
    if (groupId === undefined) {
      if (req.method !== "POST") return problem(res, 404, "not_found");
      const name = await nameOf();
      if (name === "" || name.length > 128) return problem(res, 422, "validation_failed");
      if (taken(name)) return problem(res, 409, "conflict");
      const at = new Date().toISOString();
      const g = { id: randomUUID(), name, created_at: at, updated_at: at };
      consumerGroups.push(g);
      return send(res, 201, groupOut(g));
    }
    const g = consumerGroups.find((x) => x.id === decodeURIComponent(groupId));
    if (!g) return problem(res, 404, "not_found");
    if (req.method === "DELETE") {
      consumerGroups = consumerGroups.filter((x) => x !== g);
      for (const [c, id] of consumerAssignments) if (id === g.id) consumerAssignments.delete(c);
      return send(res, 204);
    }
    if (req.method !== "PUT") return problem(res, 404, "not_found");
    const name = await nameOf();
    if (name === "" || name.length > 128) return problem(res, 422, "validation_failed");
    if (taken(name, g.id)) return problem(res, 409, "conflict");
    g.name = name;
    g.updated_at = new Date().toISOString();
    return send(res, 200, groupOut(g));
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
  if (req.method === "POST" && path === "/__fake/timeline-down") {
    // Test hook: only the Explore timeline (#587) answers 503 for `project`, or again normally.
    const { project, down } = await readBody(req);
    if (down) timelineDown.add(String(project));
    else timelineDown.delete(String(project));
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
      extra,
    } = await readBody(req);
    const codes = Array.isArray(backups) ? backups.map(String) : [];
    const seeded: Seeds = {
      passkeys: Array.isArray(seeds) ? (seeds as Record<string, unknown>[]) : [],
      capabilities: Array.isArray(caps) ? caps.map(String) : undefined,
      apiKeys: Array.isArray(keys) ? (keys as Record<string, unknown>[]) : [],
      sso: typeof sso === "object" && sso !== null && !Array.isArray(sso) ? (sso as Record<string, unknown>) : undefined,
      joinable: Array.isArray(joinable) ? (joinable as Record<string, unknown>[]) : [],
      extra: typeof extra === "object" && extra !== null && !Array.isArray(extra) ? (extra as Seeds["extra"]) : undefined,
    };
    const r = ROLES.has(role as Role) ? (role as Role) : "owner";
    const code = issueHandoff(String(next ?? "/"), typeof secret === "string" ? secret : undefined, codes, seeded, stale === true, r);
    return send(res, 200, { code });
  }
  if (await alerts(req, res, path, url)) return;
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

/** Shop's alert rules, channels and events (#610), as the alerts API (#609) keeps them. */
type FakeRule = Record<string, unknown> & { id: string; name: string; app_id: string; metric: string; condition: string; threshold: number; enabled: boolean };
type FakeChannel = { id: string; type: string; name: string; config: Record<string, unknown>; created_by: null; created_at: string; updated_at: string };
type FakeEvent = { id: string; rule_id: string; state: "triggered" | "resolved"; value: number; started_at: string; ended_at: string | null; notified_at: string | null };
let alertRules: FakeRule[] = [];
let alertChannels: FakeChannel[] = [];
let alertEvents: FakeEvent[] = [];

const ALERT_METRICS = new Set(["traffic", "errors", "error_rate", "p50", "p75", "p95", "apdex", "unique_consumers"]);
const ALERT_CONDITIONS = new Set(["gt", "gte", "lt", "lte"]);

function eventOut(e: FakeEvent) {
  const r = alertRules.find((x) => x.id === e.rule_id);
  return { ...e, rule_name: r?.name ?? "", app_id: r?.app_id ?? "", environment: r?.environment ?? "", metric: r?.metric ?? "" };
}

function ruleOut(r: FakeRule) {
  const open = alertEvents.find((e) => e.rule_id === r.id && e.state === "triggered");
  const latest = alertEvents.find((e) => e.rule_id === r.id);
  const state = latest
    ? { status: open ? "triggered" : "ok", since: open?.started_at ?? latest.ended_at, evaluated_at: new Date().toISOString(), value: latest.value, breached: Boolean(open) }
    : undefined;
  return { ...r, ...(state ? { state } : {}) };
}

/** The rule body as the API checks it, or the problem code. */
function checkRule(b: Record<string, unknown>, create: boolean): { ok: true; rule: Record<string, unknown> } | { ok: false; status: number; code: string } {
  const name = String(b.name ?? "").trim();
  const env = String(b.environment ?? "").trim();
  const threshold = Number(b.threshold);
  const every = b.every_s === undefined || b.every_s === null ? null : Number(b.every_s);
  const cron = typeof b.cron === "string" && b.cron ? b.cron : null;
  if (!name || name.length > 128 || !env || !ALERT_METRICS.has(String(b.metric)) || !ALERT_CONDITIONS.has(String(b.condition))) return { ok: false, status: 422, code: "validation_failed" };
  if (!Number.isFinite(threshold) || threshold < 0 || ((b.metric === "error_rate" || b.metric === "apdex") && threshold > 1)) return { ok: false, status: 422, code: "validation_failed" };
  if ((every === null) === (cron === null)) return { ok: false, status: 422, code: "validation_failed" };
  if (create && !shopApps.some((a) => a.id === b.app_id)) return { ok: false, status: 422, code: "validation_failed" };
  const channels = Array.isArray(b.channel_ids) ? b.channel_ids.map(String) : [];
  if (channels.some((c) => !alertChannels.some((x) => x.id === c))) return { ok: false, status: 422, code: "validation_failed" };
  return {
    ok: true,
    rule: {
      environment: env,
      name,
      description: String(b.description ?? ""),
      metric: b.metric,
      condition: b.condition,
      threshold,
      window_s: Number(b.window_s ?? 300),
      every_s: every,
      cron,
      notify_after_s: Number(b.notify_after_s ?? 0),
      resolve_after_s: Number(b.resolve_after_s ?? 0),
      filters: (b.filters as Record<string, unknown>) ?? {},
      channel_ids: channels,
      enabled: b.enabled !== false,
    },
  };
}

/** The alerts API (#609) for shop, plus the `/__fake/alerts` hook. True when it answered. */
async function alerts(req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<boolean> {
  if (req.method === "POST" && path === "/__fake/alerts") {
    const b = await readBody(req);
    if (b.reset) {
      alertRules = [];
      alertChannels = [];
      alertEvents = [];
    }
    const trigger = b.trigger as { rule?: string; value?: number; minutes_ago?: number } | undefined;
    if (trigger) {
      const r = alertRules.find((x) => x.name === trigger.rule);
      if (!r) return problem(res, 404, "not_found"), true;
      const at = new Date(Date.now() - (trigger.minutes_ago ?? 0) * 60_000).toISOString();
      alertEvents.unshift({ id: randomUUID(), rule_id: r.id, state: "triggered", value: Number(trigger.value ?? 0), started_at: at, ended_at: null, notified_at: at });
    }
    if (typeof b.resolve === "string") {
      const r = alertRules.find((x) => x.name === b.resolve);
      const open = alertEvents.find((e) => e.rule_id === r?.id && e.state === "triggered");
      if (!open) return problem(res, 404, "not_found"), true;
      open.state = "resolved";
      open.ended_at = new Date().toISOString();
    }
    return send(res, 204), true;
  }

  const m = path.match(/^\/api\/v1\/projects\/([^/]+)\/(incidents|alerts\/(rules|channels|events)(?:\/([^/]+)(\/test)?)?)$/);
  if (!m) return false;
  const user = signedInUser(req);
  if (!user) return problem(res, 401, "unauthenticated"), true;
  const slug = decodeURIComponent(m[1]);
  const [, , what, kind, id, test] = m;
  if (slug !== PROJECT) {
    // A project made in onboarding has no alerts yet.
    if (createdProjects.get(slug)?.owner === user && req.method === "GET") {
      return send(res, 200, what === "incidents" ? { range: url.searchParams.get("range") ?? "7d", incidents: [] } : { rules: [], channels: [], events: [], next_cursor: "" }), true;
    }
    return problem(res, 404, "not_found"), true;
  }
  if (queryDown.has(slug) && req.method === "GET") return problem(res, 503, "unavailable"), true;

  if (what === "incidents") {
    if (req.method !== "GET") return problem(res, 405, "method_not_allowed"), true;
    const incidents = alertRules
      .filter((r) => alertEvents.some((e) => e.rule_id === r.id))
      .map((r) => {
        const evs = alertEvents.filter((e) => e.rule_id === r.id);
        const latest = evs[0];
        return {
          rule_id: r.id,
          rule_name: r.name,
          app_id: r.app_id,
          environment: r.environment,
          metric: r.metric,
          condition: r.condition,
          threshold: r.threshold,
          status: latest.state === "triggered" ? "triggered" : "ok",
          open: latest.state === "triggered",
          events: evs.length,
          first_started_at: evs[evs.length - 1].started_at,
          latest: eventOut(latest),
        };
      })
      .sort((a, b) => Number(b.open) - Number(a.open) || b.latest.started_at.localeCompare(a.latest.started_at));
    return send(res, 200, { range: url.searchParams.get("range") ?? "7d", incidents }), true;
  }

  if (kind === "events") {
    const rule = url.searchParams.get("rule_id");
    const events = alertEvents.filter((e) => !rule || e.rule_id === rule).map(eventOut);
    return send(res, 200, { events, next_cursor: "" }), true;
  }

  if (req.method !== "GET" && !capabilitiesOf(user).includes("alerts.manage")) return problem(res, 403, "forbidden"), true;
  const now = new Date().toISOString();

  if (kind === "rules") {
    if (id === undefined) {
      if (req.method === "GET") return send(res, 200, { rules: [...alertRules].sort((a, b) => a.name.localeCompare(b.name)).map(ruleOut) }), true;
      if (req.method !== "POST") return problem(res, 405, "method_not_allowed"), true;
      const b = await readBody(req);
      const checked = checkRule(b, true);
      if (!checked.ok) return problem(res, checked.status, checked.code), true;
      const r = { id: randomUUID(), app_id: String(b.app_id), ...checked.rule, created_by: user, created_at: now, updated_at: now } as unknown as FakeRule;
      alertRules.push(r);
      return send(res, 201, ruleOut(r)), true;
    }
    const r = alertRules.find((x) => x.id === decodeURIComponent(id));
    if (!r) return problem(res, 404, "not_found"), true;
    if (req.method === "GET") return send(res, 200, ruleOut(r)), true;
    if (req.method === "DELETE") {
      alertRules = alertRules.filter((x) => x !== r);
      alertEvents = alertEvents.filter((e) => e.rule_id !== r.id);
      return send(res, 204), true;
    }
    if (req.method !== "PUT") return problem(res, 405, "method_not_allowed"), true;
    const checked = checkRule(await readBody(req), false);
    if (!checked.ok) return problem(res, checked.status, checked.code), true;
    Object.assign(r, checked.rule, { updated_at: now });
    return send(res, 200, ruleOut(r)), true;
  }

  // Channels: configs are kept but never returned.
  const out = ({ config: _config, ...c }: FakeChannel) => c;
  const taken = (name: string, except?: string) => alertChannels.some((c) => c.id !== except && c.name.toLowerCase() === name.toLowerCase());
  if (id === undefined) {
    if (req.method === "GET") return send(res, 200, { channels: [...alertChannels].sort((a, b) => a.name.localeCompare(b.name)).map(out) }), true;
    if (req.method !== "POST") return problem(res, 405, "method_not_allowed"), true;
    const b = await readBody(req);
    const name = String(b.name ?? "").trim();
    if (!name || !["email", "slack", "teams", "webhook"].includes(String(b.type)) || typeof b.config !== "object" || b.config === null) return problem(res, 422, "validation_failed"), true;
    if (taken(name)) return problem(res, 409, "conflict"), true;
    const c: FakeChannel = { id: randomUUID(), type: String(b.type), name, config: b.config as Record<string, unknown>, created_by: null, created_at: now, updated_at: now };
    alertChannels.push(c);
    return send(res, 201, out(c)), true;
  }
  const c = alertChannels.find((x) => x.id === decodeURIComponent(id));
  if (!c) return problem(res, 404, "not_found"), true;
  if (test) {
    if (req.method !== "POST") return problem(res, 405, "method_not_allowed"), true;
    if (JSON.stringify(c.config).includes("gone")) {
      return send(res, 502, { status: 502, title: "Bad Gateway", detail: "the channel did not accept the test notification: alerts: delivery failed: HTTP 410" }, "application/problem+json"), true;
    }
    return send(res, 200, { sent: true }), true;
  }
  if (req.method === "GET") return send(res, 200, out(c)), true;
  if (req.method === "DELETE") {
    alertChannels = alertChannels.filter((x) => x !== c);
    for (const r of alertRules) r.channel_ids = ((r.channel_ids as string[]) ?? []).filter((x) => x !== c.id);
    return send(res, 204), true;
  }
  if (req.method !== "PUT") return problem(res, 405, "method_not_allowed"), true;
  const b = await readBody(req);
  const name = String(b.name ?? "").trim();
  if (!name) return problem(res, 422, "validation_failed"), true;
  if (taken(name, c.id)) return problem(res, 409, "conflict"), true;
  c.name = name;
  if (typeof b.config === "object" && b.config !== null) c.config = b.config as Record<string, unknown>;
  c.updated_at = now;
  return send(res, 200, out(c)), true;
}

createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) problem(res, 500, "internal_error");
  });
}).listen(PORT, () => console.log(`fake identity on ${SELF} (ui ${UI_URL})`));
