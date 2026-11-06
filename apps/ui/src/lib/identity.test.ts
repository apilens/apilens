import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  ApiError,
  CLIENT_ERROR_CODES,
  codeForStatus,
  contextFromHeaders,
  createClient,
  errorFromResponse,
  isTwoFactorRequired,
  parseRetryAfter,
} = await import("./identity");

const BASE = "http://apilens.test:8080";

function problem(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/problem+json", ...headers },
  });
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

interface Recorded {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function recordingClient(respond: (req: Recorded) => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req: Recorded = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(req);
    return respond(req);
  });
  const client = createClient({ baseUrl: BASE, fetch: fetchMock as unknown as typeof fetch });
  return { client, calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-11-04T12:00:00Z");

  it.each([
    [null, null],
    [undefined, null],
    ["", null],
    ["  ", null],
    ["30", 30],
    [" 0 ", 0],
    ["soon", null],
    ["-5", null],
    ["Wed, 04 Nov 2026 12:00:45 GMT", 45],
    ["Wed, 04 Nov 2026 11:59:00 GMT", 0],
  ])("parses %j as %j", (input, expected) => {
    expect(parseRetryAfter(input, now)).toBe(expected);
  });
});

describe("codeForStatus", () => {
  it.each([
    [400, "bad_request"],
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [409, "conflict"],
    [422, "validation_failed"],
    [429, "rate_limited"],
    [500, "server_error"],
    [501, "server_error"],
    [502, "unavailable"],
    [503, "unavailable"],
    [504, "unavailable"],
    [418, "unknown_error"],
  ])("maps %i to %s", (status, code) => {
    expect(codeForStatus(status)).toBe(code);
  });
});

describe("errorFromResponse", () => {
  it("uses the problem's code, detail and retry_after", async () => {
    const err = await errorFromResponse(
      problem(400, {
        title: "Bad Request",
        status: 400,
        detail: "That code is not valid.",
        code: "invalid_code",
        retry_after: 12,
      }),
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(err.code).toBe("invalid_code");
    expect(err.message).toBe("That code is not valid.");
    expect(err.retryAfter).toBe(12);
    expect(err.problem?.title).toBe("Bad Request");
  });

  it("prefers the Retry-After header over the body", async () => {
    const err = await errorFromResponse(
      problem(429, { status: 429, code: "rate_limited", retry_after: 5 }, { "retry-after": "60" }),
    );
    expect(err.code).toBe("rate_limited");
    expect(err.retryAfter).toBe(60);
  });

  it("keeps slug_taken suggestions", async () => {
    const err = await errorFromResponse(problem(409, { status: 409, code: "slug_taken", suggestions: ["acme-hq", 3, "acme-2"] }));
    expect(err.code).toBe("slug_taken");
    expect(err.problem?.suggestions).toEqual(["acme-hq", "acme-2"]);
  });

  it("parses an HTTP-date Retry-After", async () => {
    const now = Date.parse("2026-11-04T12:00:00Z");
    const err = await errorFromResponse(
      problem(503, {}, { "retry-after": "Wed, 04 Nov 2026 12:00:10 GMT" }),
      null,
      now,
    );
    expect(err.retryAfter).toBe(10);
    expect(err.code).toBe("unavailable");
  });

  it("rounds a fractional retry_after up and ignores junk", async () => {
    expect((await errorFromResponse(problem(429, { retry_after: 1.2 }))).retryAfter).toBe(2);
    expect((await errorFromResponse(problem(429, { retry_after: "x" }))).retryAfter).toBeNull();
  });

  it("falls back to the status code when the problem has no code", async () => {
    const err = await errorFromResponse(problem(401, { title: "Unauthorized", status: 401 }));
    expect(err.code).toBe("unauthorized");
    expect(err.message).toBe("Unauthorized");
    expect(err.retryAfter).toBeNull();
  });

  it("treats a blank code as missing", async () => {
    expect((await errorFromResponse(problem(404, { code: "  " }))).code).toBe("not_found");
  });

  it("handles a non-JSON error body", async () => {
    const res = new Response("<html>bad gateway</html>", {
      status: 502,
      headers: { "content-type": "text/html" },
    });
    const err = await errorFromResponse(res);
    expect(err.status).toBe(502);
    expect(err.code).toBe("unavailable");
    expect(err.problem).toBeNull();
    expect(err.message).toBe("HTTP 502");
  });

  it("handles malformed JSON and non-object JSON", async () => {
    const broken = new Response("{not json", {
      status: 500,
      headers: { "content-type": "application/problem+json" },
    });
    expect((await errorFromResponse(broken)).code).toBe("server_error");
    expect((await errorFromResponse(problem(400, ["a"]))).problem).toBeNull();
  });

  it("takes the request id from the response, else the sent one", async () => {
    const echoed = await errorFromResponse(problem(400, {}, { "x-request-id": "srv-1" }), "sent-1");
    expect(echoed.requestId).toBe("srv-1");
    expect((await errorFromResponse(problem(400, {}), "sent-1")).requestId).toBe("sent-1");
  });

  it("keeps every field of the spec's ErrorModel", async () => {
    const spec = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../../../api/openapi/apilens.v1.json", import.meta.url)),
        "utf8",
      ),
    );
    const model = spec.components.schemas.ErrorModel.properties as Record<string, unknown>;
    const body: Record<string, unknown> = {
      type: "about:blank",
      title: "Conflict",
      status: 409,
      detail: "Slug is taken.",
      instance: "/api/v1/orgs",
      errors: [{ location: "body.slug", message: "taken", value: "acme" }],
    };
    const fields = Object.keys(model).filter((k) => k !== "$schema");
    expect(fields.sort()).toEqual(Object.keys(body).sort());
    const err = await errorFromResponse(problem(409, { ...body, code: "slug_taken" }));
    expect(err.problem).toEqual({ ...body, code: "slug_taken" });
  });
});

describe("request transport", () => {
  it("sends JSON with a generated X-Request-Id and parses the body", async () => {
    const { client, calls } = recordingClient(() => json({ sent: true, retry_after: 30 }));
    const out = await client.emailStart({ email: "a@b.co", intent: "signup", remember: true });
    expect(out).toEqual({ sent: true, retry_after: 30 });
    const [call] = calls;
    expect(call.url).toBe(`${BASE}/api/v1/auth/email/start`);
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({ email: "a@b.co", intent: "signup", remember: true });
    expect(call.headers.get("content-type")).toBe("application/json");
    expect(call.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(call.headers.get("authorization")).toBeNull();
  });

  it("propagates request id, client IP, user agent and bearer token", async () => {
    const { client, calls } = recordingClient(() => json({ id: "u1" }));
    await client.me({
      accessToken: "jwt",
      requestId: "req-42",
      forwardedFor: "203.0.113.9",
      userAgent: "Firefox",
    });
    const h = calls[0].headers;
    expect(h.get("x-request-id")).toBe("req-42");
    expect(h.get("x-forwarded-for")).toBe("203.0.113.9");
    expect(h.get("user-agent")).toBe("Firefox");
    expect(h.get("authorization")).toBe("Bearer jwt");
    expect(calls[0].body).toBeUndefined();
    expect(h.get("content-type")).toBeNull();
  });

  it("throws ApiError carrying the sent request id when the server does not echo one", async () => {
    const { client } = recordingClient(() =>
      problem(400, { code: "invalid_code", detail: "Wrong code" }),
    );
    const err = await client
      .emailVerify({ email: "a@b.co", code: "000000" }, { requestId: "req-7" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 400, code: "invalid_code", requestId: "req-7" });
  });

  it("maps a network failure to status 0 network_error", async () => {
    const { client } = recordingClient(() => {
      throw new TypeError("fetch failed");
    });
    const err = await client.providers({ requestId: "r" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 0, code: CLIENT_ERROR_CODES.network, requestId: "r" });
    expect((err as Error).cause).toBeInstanceOf(TypeError);
  });

  it("maps a timeout to status 0 timeout", async () => {
    const fetchMock = vi.fn(
      (_: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const client = createClient({
      baseUrl: BASE,
      fetch: fetchMock as unknown as typeof fetch,
      timeoutMs: 5,
    });
    const err = await client.providers().catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 0, code: CLIENT_ERROR_CODES.timeout });
  });

  it("maps a caller abort to network_error, not timeout", async () => {
    const controller = new AbortController();
    const { client } = recordingClient(() => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    const err = await client.providers({ signal: controller.signal }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 0, code: CLIENT_ERROR_CODES.network });
  });

  it("returns undefined for 204 and empty bodies", async () => {
    const { client } = recordingClient(() => new Response(null, { status: 204 }));
    await expect(client.logout({ refresh_token: "r" })).resolves.toBeUndefined();
  });

  it("rejects a non-JSON success body", async () => {
    const { client } = recordingClient(() => new Response("ok", { status: 200 }));
    const err = await client.providers().catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 200, code: CLIENT_ERROR_CODES.unknown });
  });

  it("tolerates a trailing slash in the base URL", async () => {
    const calls: string[] = [];
    const client = createClient({
      baseUrl: `${BASE}/`,
      fetch: (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return json({});
      }) as typeof fetch,
    });
    await client.providers();
    expect(calls).toEqual([`${BASE}/api/v1/auth/providers`]);
  });
});

describe("operations", () => {
  const authed = { accessToken: "jwt" };
  type Client = ReturnType<typeof createClient>;

  // [method, path template under /api/v1, call]
  const routes: [string, string, (c: Client) => Promise<unknown>][] = [
    ["GET", "/auth/providers", (c) => c.providers()],
    ["GET", "/auth/sso/lookup", (c) => c.ssoLookup("ada@example.com")],
    ["POST", "/auth/email/start", (c) => c.emailStart({ email: "a@b.co", intent: "signin" })],
    ["POST", "/auth/email/verify", (c) => c.emailVerify({ email: "a@b.co", code: "123456" })],
    ["POST", "/auth/email/verify-link", (c) => c.emailVerifyLink({ token: "t" })],
    ["POST", "/auth/handoff", (c) => c.handoff({ code: "h" })],
    ["POST", "/auth/2fa/exchange", (c) => c.twoFactorExchange({ pre_auth_token: "p", code: "1" })],
    ["POST", "/auth/passkeys/login/options", (c) => c.passkeyLoginOptions()],
    [
      "POST",
      "/auth/passkeys/login/verify",
      (c) => c.passkeyLoginVerify({ challenge_id: "c", response: {} }),
    ],
    ["POST", "/auth/passkeys/register/options", (c) => c.passkeyRegisterOptions(authed)],
    [
      "POST",
      "/auth/passkeys/register/verify",
      (c) => c.passkeyRegisterVerify({ challenge_id: "c", response: {}, name: "Laptop" }, authed),
    ],
    ["GET", "/auth/oidc/requests/{id}", (c) => c.oidcRequest("a/b?c")],
    ["POST", "/auth/oidc/requests/{id}/complete", (c) => c.oidcComplete("a/b?c", authed)],
    ["POST", "/auth/refresh", (c) => c.refresh({ refresh_token: "r" })],
    ["POST", "/auth/logout", (c) => c.logout({ refresh_token: "r" })],
    ["GET", "/users/me", (c) => c.me(authed)],
    ["GET", "/users/me/context", (c) => c.context(authed)],
    ["GET", "/users/me/sessions", (c) => c.listSessions(authed)],
    ["DELETE", "/users/me/sessions/{id}", (c) => c.revokeSession("a/b?c", authed)],
    ["POST", "/users/me/sessions/revoke-others", (c) => c.revokeOtherSessions(authed)],
    ["GET", "/users/me/identities", (c) => c.listIdentities(authed)],
    ["DELETE", "/users/me/identities/{id}", (c) => c.deleteIdentity("a/b?c", authed)],
    ["GET", "/users/me/passkeys", (c) => c.listMyPasskeys(authed)],
    ["PATCH", "/users/me/passkeys/{id}", (c) => c.renameMyPasskey("a/b?c", { name: "Laptop" }, authed)],
    ["DELETE", "/users/me/passkeys/{id}", (c) => c.deleteMyPasskey("a/b?c", authed)],
    ["PATCH", "/users/me", (c) => c.updateMe({ name: "Ada" }, authed)],
    ["DELETE", "/users/me", (c) => c.deleteMe(authed)],
    ["PATCH", "/users/me/onboarding", (c) => c.updateOnboarding({ step: "about" }, authed)],
    ["POST", "/users/me/email/change", (c) => c.startEmailChange({ new_email: "new@example.com" }, authed)],
    ["POST", "/users/me/email/confirm", (c) => c.confirmEmailChange({ code: "123456" }, authed)],
    ["GET", "/auth/invitations/{token}", (c) => c.invitationLookup("a/b?c")],
    ["POST", "/auth/invitations/{token}/accept", (c) => c.invitationAccept("a/b?c", authed)],
    ["POST", "/auth/recovery/request", (c) => c.recoveryRequest({ email: "a@example.com" })],
    ["GET", "/auth/recovery/status", (c) => c.recoveryStatus("tok")],
    ["POST", "/auth/recovery/confirm", (c) => c.recoveryConfirm({ token: "tok" })],
    ["POST", "/auth/recovery/cancel", (c) => c.recoveryCancel({ token: "tok" })],
    ["GET", "/orgs", (c) => c.listOrgs(authed)],
    ["POST", "/orgs", (c) => c.createOrg({ name: "Acme", slug: "acme" }, authed)],
    ["GET", "/users/me/joinable-orgs", (c) => c.listJoinableOrgs(authed)],
    ["POST", "/orgs/{slug}/join", (c) => c.joinOrg("a/b?c", authed)],
    ["GET", "/orgs/{slug}", (c) => c.getOrg("a/b?c", authed)],
    ["PATCH", "/orgs/{slug}", (c) => c.updateOrg("a/b?c", { name: "Acme" }, authed)],
    ["DELETE", "/orgs/{slug}", (c) => c.deleteOrg("a/b?c", authed)],
    ["GET", "/orgs/slug-available", (c) => c.orgSlugAvailable("acme", authed)],
    ["GET", "/orgs/{slug}/invitations", (c) => c.listInvitations("a/b?c", authed)],
    ["POST", "/orgs/{slug}/invitations/{id}/resend", (c) => c.resendInvitation("a/b?c", "a/b?c", authed)],
    ["DELETE", "/orgs/{slug}/invitations/{id}", (c) => c.revokeInvitation("a/b?c", "a/b?c", authed)],
    ["GET", "/orgs/{slug}/sso", (c) => c.getOrgSSO("a/b?c", authed)],
    [
      "PUT",
      "/orgs/{slug}/sso",
      (c) => c.putOrgSSO("a/b?c", { issuer: "https://idp.example.com", client_id: "c", domains: ["example.com"] }, authed),
    ],
    ["DELETE", "/orgs/{slug}/sso", (c) => c.deleteOrgSSO("a/b?c", authed)],
    ["POST", "/orgs/{slug}/sso/test", (c) => c.testOrgSSO("a/b?c", undefined, authed)],
    ["GET", "/orgs/{slug}/projects", (c) => c.listProjects("a/b?c", authed)],
    [
      "POST",
      "/orgs/{slug}/projects",
      (c) => c.createProject("a/b?c", { name: "Web", slug: "web" }, authed),
    ],
    ["GET", "/projects/{slug}", (c) => c.getProject("a/b?c", authed)],
    ["GET", "/projects/slug-available", (c) => c.projectSlugAvailable("web", authed)],
    ["GET", "/projects/{slug}/ingest-status", (c) => c.ingestStatus("a/b?c", authed)],
    ["GET", "/projects/{slug}/api-keys", (c) => c.listApiKeys("a/b?c", authed)],
    [
      "POST",
      "/projects/{slug}/api-keys",
      (c) => c.createApiKey("a/b?c", { name: "ingest", scopes: ["ingest"] }, authed),
    ],
    ["DELETE", "/projects/{slug}/api-keys/{id}", (c) => c.revokeApiKey("a/b?c", "a/b?c", authed)],
    ["GET", "/projects/{slug}/privacy-policy", (c) => c.getPrivacyPolicy("a/b?c", authed)],
    [
      "PUT",
      "/projects/{slug}/privacy-policy",
      (c) => c.putPrivacyPolicy("a/b?c", { mask_query_params: [], mask_headers: [], mask_body_fields: [] }, authed),
    ],
    ["GET", "/projects/{project}/alerts/health-checks", (c) => c.listHealthChecks("a/b?c", authed)],
    [
      "POST",
      "/projects/{project}/alerts/health-checks",
      (c) => c.createHealthCheck("a/b?c", { app_id: "a1", environment: "production", url: "https://api.example.com/healthz" }, authed),
    ],
    ["DELETE", "/projects/{project}/alerts/health-checks/{id}", (c) => c.deleteHealthCheck("a/b?c", "a/b?c", authed)],
    ["GET", "/projects/{project}/alerts/health-checks/{id}/events", (c) => c.healthCheckEvents("a/b?c", "a/b?c", 5, authed)],
    ["GET", "/requests", (c) => c.listRequests("web", { range: "7d", limit: 10 }, authed)],
    ["GET", "/traffic/summary", (c) => c.trafficSummary("web", "7d", authed)],
    ["GET", "/traffic/endpoints", (c) => c.listEndpoints("web", { range: "7d" }, authed)],
    ["GET", "/traffic/timeseries", (c) => c.trafficTimeseries("web", { range: "7d" }, authed)],
    ["GET", "/traffic/latency", (c) => c.trafficLatency("web", { range: "7d" }, authed)],
    ["GET", "/deploys/changes", (c) => c.deployChanges("web", { range: "7d" }, authed)],
    ["GET", "/consumers", (c) => c.listConsumers("web", { range: "7d" }, authed)],
    ["GET", "/consumers/{consumer_id}", (c) => c.getConsumer("web", "a/b?c", { range: "7d" }, authed)],
    ["GET", "/projects/{slug}/consumer-groups", (c) => c.listConsumerGroups("a/b?c", authed)],
    ["GET", "/consumer-groups", (c) => c.listConsumerGroupTraffic("web", { range: "7d", sort: "consumers" }, authed)],
    ["GET", "/projects/{slug}/views", (c) => c.listSavedViews("a/b?c", "explore", authed)],
    ["POST", "/projects/{slug}/views", (c) => c.createSavedView("a/b?c", { name: "5xx", surface: "explore", filter: {}, shared: false }, authed)],
    ["PUT", "/projects/{slug}/views/{id}", (c) => c.updateSavedView("a/b?c", "a/b?c", { name: "5xx", filter: {}, shared: true }, authed)],
    ["DELETE", "/projects/{slug}/views/{id}", (c) => c.deleteSavedView("a/b?c", "a/b?c", authed)],
    ["POST", "/projects/{project}/exports", (c) => c.createRequestExport("a/b?c", { range: "1h" }, authed)],
    ["GET", "/exports/{id}", (c) => c.getRequestExport("a/b?c", authed)],
    ["POST", "/exports/{id}/cancel", (c) => c.cancelRequestExport("a/b?c", authed)],
  ];

  it.each(routes)("%s %s", async (method, template, call) => {
    const { client, calls } = recordingClient(() => json({}));
    await call(client);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(calls[0].method).toBe(method);
    // Path parameters are encoded as a single segment.
    expect(url.pathname).toBe(`/api/v1${template.replace(/\{[^}]+\}/g, "a%2Fb%3Fc")}`);
  });

  it("sends the SSO lookup email as a query parameter", async () => {
    const { client, calls } = recordingClient(() => json({ sso: false, enforced: false }));
    await client.ssoLookup("ada+x@example.com");
    expect(new URL(calls[0].url).searchParams.get("email")).toBe("ada+x@example.com");
  });

  it("sends slug availability as a query parameter", async () => {
    const { client, calls } = recordingClient(() => json({ available: true, suggestions: [] }));
    await client.orgSlugAvailable("acme co", authed);
    expect(new URL(calls[0].url).searchParams.get("slug")).toBe("acme co");
  });

  it("sends the query operations' project, range and limit as query parameters, as the user", async () => {
    const { client, calls } = recordingClient(() => json({}));
    await client.listRequests("my-api", { range: "7d", limit: 10 }, authed);
    await client.trafficSummary("my-api", "24h", authed);
    await client.listEndpoints("my-api", { range: "7d", limit: 500 }, authed);
    await client.deployChanges("my-api", { range: "7d", limit: 25 }, authed);
    await client.listConsumers("my-api", { range: "6h", group: "Acme Corp", search: "priya", sort: "errors", limit: 25, offset: 50 }, authed);
    await client.getConsumer("my-api", "acme", { range: "1h" }, authed);
    await client.trafficSummary("my-api", { range: "6h", env: "production" }, authed);
    await client.trafficTimeseries("my-api", { range: "1h", env: "" }, authed);
    await client.listEndpoints("my-api", { range: "24h", env: "staging", limit: 100 }, authed);
    expect(calls.map((c) => Object.fromEntries(new URL(c.url).searchParams))).toEqual([
      { project: "my-api", range: "7d", limit: "10" },
      { project: "my-api", range: "24h" },
      { project: "my-api", range: "7d", limit: "500" },
      { project: "my-api", range: "7d", limit: "25" },
      { project: "my-api", range: "6h", group: "Acme Corp", search: "priya", sort: "errors", limit: "25", offset: "50" },
      { project: "my-api", range: "1h" },
      { project: "my-api", range: "6h", env: "production" },
      { project: "my-api", range: "1h" },
      { project: "my-api", range: "24h", env: "staging", limit: "100" },
    ]);
    expect(calls.every((c) => c.headers.get("authorization") === "Bearer jwt")).toBe(true);
  });

  it("narrows the traffic totals and timeseries to an app and reads its status in the project (#591)", async () => {
    const { client, calls } = recordingClient(() => json({}));
    await client.trafficSummary("my-api", { range: "24h", app: "a1" }, authed);
    await client.trafficTimeseries("my-api", { range: "24h", app: "a1" }, authed);
    await client.appHealthStatus("my-api", "a1", authed);
    expect(calls.map((c) => Object.fromEntries(new URL(c.url).searchParams))).toEqual([
      { project: "my-api", range: "24h", app: "a1" },
      { project: "my-api", range: "24h", app: "a1" },
      { project: "my-api" },
    ]);
  });

  it("starts a link flow as the user and answers the provider URL it redirects to", async () => {
    const provider = "https://github.com/login/oauth/authorize?state=s";
    const { client, calls } = recordingClient(
      () => new Response(null, { status: 302, headers: { location: provider } }),
    );
    await expect(client.oauthLinkStart("github", "/settings/connected-accounts", authed)).resolves.toBe(provider);
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/api/v1/auth/oauth/github/start");
    expect(url.searchParams.get("intent")).toBe("link");
    expect(url.searchParams.get("next")).toBe("/settings/connected-accounts");
    expect(calls[0].headers.get("authorization")).toBe("Bearer jwt");
  });

  it("a refused link start is an ApiError", async () => {
    const { client } = recordingClient(() => problem(401, { code: "unauthenticated" }));
    await expect(client.oauthLinkStart("google", "/", authed)).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
  });

  it("other redirects stay errors", async () => {
    const { client } = recordingClient(
      () => new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } }),
    );
    await expect(client.listIdentities(authed)).rejects.toBeInstanceOf(ApiError);
  });

  it("uses the method the committed OpenAPI spec declares for every path it already has", () => {
    const spec = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../../../api/openapi/apilens.v1.json", import.meta.url)),
        "utf8",
      ),
    ) as { paths: Record<string, Record<string, unknown>> };
    // Operations on a path the spec already has but that are not built yet.
    const pending = new Set<string>();
    for (const [method, template] of routes) {
      const item = spec.paths[`/api/v1${template}`];
      if (item && !pending.has(`${method} ${template}`) && !(method.toLowerCase() in item)) {
        expect.fail(`${method} ${template} is not in the committed spec`);
      }
    }
  });
});

describe("helpers", () => {
  it("isTwoFactorRequired discriminates sign-in results", () => {
    expect(isTwoFactorRequired({ status: "2fa_required", pre_auth_token: "p" })).toBe(true);
    expect(
      isTwoFactorRequired({
        access_token: "a",
        refresh_token: "r",
        expires_in: 900,
        user: {} as never,
      }),
    ).toBe(false);
  });

  it("contextFromHeaders picks only what it forwards", () => {
    expect(
      contextFromHeaders(
        new Headers({
          "x-request-id": "rid",
          "x-forwarded-for": "198.51.100.1, 10.0.0.1",
          "user-agent": "Safari",
          cookie: "apilens_session=secret",
        }),
      ),
    ).toEqual({ requestId: "rid", forwardedFor: "198.51.100.1, 10.0.0.1", userAgent: "Safari" });
    expect(contextFromHeaders(new Headers({ "x-real-ip": "192.0.2.4" }))).toEqual({
      forwardedFor: "192.0.2.4",
    });
    expect(contextFromHeaders(new Headers())).toEqual({});
  });
});

describe("endpoint detail operations (#593)", () => {
  const authed = { accessToken: "jwt" };
  const ROUTE = "%2Forders%2F%7Bid%7D";

  it("sends method and route template as one encoded segment each, with the scope as query parameters", async () => {
    const { client, calls } = recordingClient(() => json({}));
    const scope = { range: "1h", env: "production", status: "5xx", consumer: "acme" } as const;
    await client.endpointRequests("my-api", "GET", "/orders/{id}", scope, authed);
    await client.endpointErrors("my-api", "GET", "/orders/{id}", { range: "7d", env: "", consumer: "" }, authed);
    await client.endpointLatency("my-api", "GET", "/orders/{id}", { ...scope, status: "all" }, authed);
    await client.endpointTransfer("my-api", "GET", "/orders/{id}", { range: "24h" }, authed);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      `/api/v1/endpoints/GET/${ROUTE}/requests`,
      `/api/v1/endpoints/GET/${ROUTE}/errors`,
      `/api/v1/endpoints/GET/${ROUTE}/latency`,
      `/api/v1/endpoints/GET/${ROUTE}/transfer`,
    ]);
    expect(calls.map((c) => Object.fromEntries(new URL(c.url).searchParams))).toEqual([
      { project: "my-api", range: "1h", env: "production", status: "5xx", consumer: "acme" },
      { project: "my-api", range: "7d" },
      { project: "my-api", range: "1h", env: "production", consumer: "acme" },
      { project: "my-api", range: "24h" },
    ]);
    expect(calls.every((c) => c.method === "GET" && c.headers.get("authorization") === "Bearer jwt")).toBe(true);
  });

  it("reads and replaces an endpoint's settings for an app", async () => {
    const { client, calls } = recordingClient(() => json({}));
    const body = { expected_status_codes: [404], latency_threshold_ms: null, excluded: true };
    await client.getEndpointSettings("my-api", "a/b?c", "POST", "/charge", authed);
    await client.putEndpointSettings("a/b?c", "POST", "/charge", body, authed);
    expect(calls.map((c) => [c.method, new URL(c.url).pathname, new URL(c.url).search])).toEqual([
      ["GET", "/api/v1/apps/a%2Fb%3Fc/endpoints/POST/%2Fcharge/settings", "?project=my-api"],
      ["PUT", "/api/v1/apps/a%2Fb%3Fc/endpoints/POST/%2Fcharge/settings", ""],
    ]);
    expect(calls[1].body).toEqual(body);
  });

  it("reads the errors dashboard with the project, range and environment, as the user", async () => {
    const { client, calls } = recordingClient(() => json({}));
    await client.errorStatuses("my-api", { range: "6h", env: "production" }, authed);
    await client.errorStatus("my-api", 404, { range: "7d", env: "" }, authed);
    await client.listErrors("my-api", { range: "1h", env: "staging" }, authed);
    expect(calls.map((c) => [c.method, new URL(c.url).pathname, Object.fromEntries(new URL(c.url).searchParams)])).toEqual([
      ["GET", "/api/v1/errors/status", { project: "my-api", range: "6h", env: "production" }],
      ["GET", "/api/v1/errors/status/404", { project: "my-api", range: "7d" }],
      ["GET", "/api/v1/errors", { project: "my-api", range: "1h", env: "staging" }],
    ]);
    expect(calls.every((c) => c.headers.get("authorization") === "Bearer jwt")).toBe(true);
  });

  it("reads the project's response times and an app's threshold, and replaces the threshold", async () => {
    const { client, calls } = recordingClient(() => json({}));
    await client.trafficLatency("my-api", { range: "6h", env: "production" }, authed);
    await client.getAppSettings("my-api", "a/b?c", authed);
    await client.putAppSettings("a/b?c", { latency_threshold_ms: 250 }, authed);
    expect(calls.map((c) => [c.method, new URL(c.url).pathname, new URL(c.url).search])).toEqual([
      ["GET", "/api/v1/traffic/latency", "?project=my-api&range=6h&env=production"],
      ["GET", "/api/v1/apps/a%2Fb%3Fc/settings", "?project=my-api"],
      ["PUT", "/api/v1/apps/a%2Fb%3Fc/settings", ""],
    ]);
    expect(calls[2].body).toEqual({ latency_threshold_ms: 250 });
  });
});
