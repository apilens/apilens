// A fake identity server plus a fake OAuth provider for the social sign-in (#317), two-factor
// step (#320) and account settings (#339) browser tests.
// It mirrors the real contract (internal/identity/oauth.go, oauth_callback.go, handoff_redeem.go):
//
//   GET  /api/v1/auth/providers                    google and github enabled
//   GET  /api/v1/auth/oauth/{provider}/start       checks `next`, keeps a state, 302 to the provider
//   GET  /fake-provider/authorize                  consent page: "Authorize" or "Deny"
//   GET  /api/v1/auth/oauth/{provider}/callback    302 to {ui}/auth/callback?code=… or /sign-in?error=…
//   POST /api/v1/auth/handoff                      redeems a one-time code (session bundle or 2fa_required)
//   POST /api/v1/auth/2fa/exchange                 spends a pre-auth token with a TOTP or backup code
//   POST /api/v1/auth/logout                       204
//   GET  /api/v1/users/me/context                  one org (acme) with one project (shop)
//   POST /__fake/handoff {next, totp_secret?, backup_codes?}
//                                                  test hook: a code whose bundle carries any `next`;
//                                                  with `totp_secret` (base32) it answers 2fa_required
//
// Nothing here sends mail or talks to a real provider. Run with
// `node --experimental-strip-types e2e-fake/fake-identity.ts` (Playwright starts it).
import { createHmac, randomBytes } from "node:crypto";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";

const PORT = Number(process.env.FAKE_IDENTITY_PORT ?? 18080);
const UI_URL = (process.env.FAKE_IDENTITY_UI_URL ?? "http://localhost:3210").replace(/\/+$/, "");
const SELF = `http://localhost:${PORT}`;
const PROVIDERS = new Set(["google", "github"]);

interface State {
  provider: string;
  next: string;
  remember: boolean;
}

interface PreAuth {
  secret: Buffer;
  backupCodes: Set<string>;
  next: string;
  attempts: number;
}

const states = new Map<string, State>();
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

function bundle(next: string) {
  const id = `usr_${token().slice(0, 8)}`;
  return {
    access_token: `at_${token()}`,
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

function issueHandoff(next: string, secret?: string, backupCodes: string[] = []): string {
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
    handoffs.set(code, bundle(next));
  }
  return code;
}

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
      if (next === null || (q.get("intent") ?? "login") !== "login") return problem(res, 400, "invalid_request");
      const state = token();
      states.set(state, { provider, next, remember: q.get("remember") === "true" });
      return redirect(res, `${SELF}/fake-provider/authorize?${new URLSearchParams({ provider, state })}`);
    }
    const state = q.get("state") ?? "";
    const st = states.get(state);
    states.delete(state);
    if (!st || st.provider !== provider) return redirect(res, `${UI_URL}/sign-in?error=oauth_state_mismatch`);
    if (q.get("error")) return redirect(res, `${UI_URL}/sign-in?error=oauth_denied`);
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
    return send(
      res,
      200,
      `<!doctype html><title>Fake ${escape(provider)}</title><h1>Fake ${escape(provider)} consent</h1>` +
        `<a href="${escape(allow)}">Authorize</a> <a href="${escape(deny)}">Deny</a>`,
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
  if (req.method === "POST" && path === "/__fake/handoff") {
    const { next, totp_secret: secret, backup_codes: backups } = await readBody(req);
    const codes = Array.isArray(backups) ? backups.map(String) : [];
    return send(res, 200, { code: issueHandoff(String(next ?? "/"), typeof secret === "string" ? secret : undefined, codes) });
  }
  return problem(res, 404, "not_found");
}

createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) problem(res, 500, "internal_error");
  });
}).listen(PORT, () => console.log(`fake identity on ${SELF} (ui ${UI_URL})`));
