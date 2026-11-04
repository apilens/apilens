// A fake identity server plus a fake OAuth provider for the social sign-in (#317), two-factor
// step (#320), account settings (#339), sessions (#343), connected accounts (#344),
// Security → Passkeys (#341) and two-factor settings (#342) browser tests.
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
//   GET  /api/v1/users/me/context                  one org (acme) with one project (shop)
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
//   POST /__fake/handoff {next, totp_secret?, backup_codes?, passkeys?, stale?}
//                                                  test hook: a code whose bundle carries any `next`;
//                                                  with `totp_secret` (base32) it answers 2fa_required;
//                                                  `passkeys` seeds the new user's passkey list;
//                                                  `stale` makes /2fa/enable answer reauth_required
//   POST /__fake/identities {identities}          test hook: replaces the connected accounts
//
// Nothing here sends mail or talks to a real provider. Run with
// `node --experimental-strip-types e2e-fake/fake-identity.ts` (Playwright starts it).
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";

const PORT = Number(process.env.FAKE_IDENTITY_PORT ?? 18080);
const UI_URL = (process.env.FAKE_IDENTITY_UI_URL ?? "http://localhost:3210").replace(/\/+$/, "");
const SELF = `http://localhost:${PORT}`;
const PROVIDERS = new Set(["google", "github"]);

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

function bundle(next: string, seeds: Record<string, unknown>[] = []) {
  const id = `usr_${token().slice(0, 8)}`;
  const access = `at_${token()}`;
  seedSessions(id, access);
  passkeys.set(id, seeds.map(seedPasskey));
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

/** `GET /users/me/context` for any signed-in fake user: one org with one project. */
const CONTEXT = {
  user: bundle("/").user,
  orgs: [
    {
      id: "org_fake",
      slug: "acme",
      name: "Acme",
      role: "owner",
      projects: [{ id: "prj_fake", slug: "shop", name: "shop", environments: ["production"] }],
    },
  ],
  last_project_slug: "shop",
  onboarding: { step: null, completed: true },
  capabilities: {},
};

function issueHandoff(
  next: string,
  secret?: string,
  backupCodes: string[] = [],
  seeds: Record<string, unknown>[] = [],
  stale = false,
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
    const b = bundle(next, seeds);
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
    return send(res, 200, { email: true, passkeys: true, google: true, github: true, sso: false });
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
    return send(res, 200, CONTEXT);
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
    const { next, totp_secret: secret, backup_codes: backups, passkeys: seeds, stale } = await readBody(req);
    const codes = Array.isArray(backups) ? backups.map(String) : [];
    const seeded = Array.isArray(seeds) ? (seeds as Record<string, unknown>[]) : [];
    const code = issueHandoff(String(next ?? "/"), typeof secret === "string" ? secret : undefined, codes, seeded, stale === true);
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

createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) problem(res, 500, "internal_error");
  });
}).listen(PORT, () => console.log(`fake identity on ${SELF} (ui ${UI_URL})`));
