// A fake identity server plus a fake OAuth provider for the social sign-in browser test (#317).
// It mirrors the real contract (internal/identity/oauth.go, oauth_callback.go, handoff_redeem.go):
//
//   GET  /api/v1/auth/providers                    google and github enabled
//   GET  /api/v1/auth/oauth/{provider}/start       checks `next`, keeps a state, 302 to the provider
//   GET  /fake-provider/authorize                  consent page: "Authorize" or "Deny"
//   GET  /api/v1/auth/oauth/{provider}/callback    302 to {ui}/auth/callback?code=… or /sign-in?error=…
//   POST /api/v1/auth/handoff                      redeems a one-time code (session bundle)
//   POST /api/v1/auth/logout                       204
//   POST /__fake/handoff {next}                    test hook: a code whose bundle carries any `next`
//
// Nothing here sends mail or talks to a real provider. Run with
// `node --experimental-strip-types e2e-fake/fake-identity.ts` (Playwright starts it).
import { randomBytes } from "node:crypto";
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

const states = new Map<string, State>();
const handoffs = new Map<string, unknown>();
const token = () => randomBytes(24).toString("base64url");

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

function issueHandoff(next: string): string {
  const code = token();
  handoffs.set(code, bundle(next));
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
  if (req.method === "POST" && path === "/api/v1/auth/logout") return send(res, 204);
  if (req.method === "POST" && path === "/__fake/handoff") {
    const { next } = await readBody(req);
    return send(res, 200, { code: issueHandoff(String(next ?? "/")) });
  }
  return problem(res, 404, "not_found");
}

createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) problem(res, 500, "internal_error");
  });
}).listen(PORT, () => console.log(`fake identity on ${SELF} (ui ${UI_URL})`));
