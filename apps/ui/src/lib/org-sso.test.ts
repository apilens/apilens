import { describe, expect, it } from "vitest";
import type { SSOConnection } from "./identity";
import {
  SSO_SECRET_MASK,
  canManageSSO,
  checkSSOForm,
  discoveredEndpoints,
  enforceState,
  issuerProblem,
  ssoError,
  ssoTestError,
} from "./org-sso";

const conn: SSOConnection = {
  issuer: "https://idp.example.com",
  client_id: "client",
  client_secret: SSO_SECRET_MASK,
  domains: ["example.com"],
  enforce: false,
  default_role: "member",
  redirect_uri: "https://apilens.test/api/v1/auth/sso/acme/callback",
  start_url: "https://apilens.test/api/v1/auth/sso/acme/start",
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
  last_login_at: null,
};

const form = {
  issuer: " https://idp.example.com ",
  clientId: " client ",
  clientSecret: "s3cret",
  domains: ["Example.com", "example.com", "example.org"],
  defaultRole: "viewer",
  enforce: false,
};

describe("canManageSSO", () => {
  it("is owners only", () => {
    expect(canManageSSO("owner")).toBe(true);
    expect(canManageSSO("admin")).toBe(false);
    expect(canManageSSO("member")).toBe(false);
    expect(canManageSSO("viewer")).toBe(false);
  });
});

describe("issuerProblem", () => {
  it("accepts https and loopback http", () => {
    expect(issuerProblem("https://idp.example.com")).toBeNull();
    expect(issuerProblem("https://idp.example.com/realms/acme")).toBeNull();
    expect(issuerProblem("http://localhost:8080")).toBeNull();
    expect(issuerProblem("http://127.0.0.1:5556/dex")).toBeNull();
  });

  it("refuses everything the API refuses", () => {
    expect(issuerProblem("")).toMatch(/Enter the issuer/);
    expect(issuerProblem("idp.example.com")).toMatch(/full URL/);
    expect(issuerProblem("http://idp.example.com")).toMatch(/https/);
    expect(issuerProblem("ftp://idp.example.com")).toMatch(/https/);
    expect(issuerProblem("https://idp.example.com?x=1")).toMatch(/query/);
    expect(issuerProblem("https://idp.example.com#x")).toMatch(/fragment/);
    expect(issuerProblem("https://u:p@idp.example.com")).toMatch(/credentials/);
    expect(issuerProblem(`https://${"a".repeat(2050)}.com`)).toMatch(/at most/);
  });
});

describe("checkSSOForm", () => {
  it("builds the PUT body from trimmed, normalized values", () => {
    expect(checkSSOForm(form, false)).toEqual({
      ok: true,
      body: {
        issuer: "https://idp.example.com",
        client_id: "client",
        client_secret: "s3cret",
        domains: ["example.com", "example.org"],
        enforce: false,
        default_role: "viewer",
      },
    });
  });

  it("keeps the stored secret when the field is empty or the mask", () => {
    const empty = checkSSOForm({ ...form, clientSecret: "" }, true);
    expect(empty.ok && "client_secret" in empty.body).toBe(false);
    const masked = checkSSOForm({ ...form, clientSecret: SSO_SECRET_MASK }, true);
    expect(masked.ok && "client_secret" in masked.body).toBe(false);
  });

  it("needs a secret for a new connection", () => {
    expect(checkSSOForm({ ...form, clientSecret: " " }, false)).toMatchObject({ ok: false, field: "clientSecret" });
  });

  it("reports the first bad field", () => {
    expect(checkSSOForm({ ...form, issuer: "nope" }, true)).toMatchObject({ ok: false, field: "issuer" });
    expect(checkSSOForm({ ...form, clientId: "" }, true)).toMatchObject({ ok: false, field: "clientId" });
    expect(checkSSOForm({ ...form, domains: [] }, true)).toMatchObject({ ok: false, field: "domains", error: /at least one/ });
    expect(checkSSOForm({ ...form, domains: ["acme"] }, true)).toMatchObject({ ok: false, field: "domains" });
    expect(checkSSOForm({ ...form, domains: "a.com" as unknown as string[] }, true)).toMatchObject({ ok: false, field: "domains" });
    expect(checkSSOForm({ ...form, defaultRole: "owner" }, true)).toMatchObject({ ok: false, field: "defaultRole" });
  });

  it("only sends enforce when it is exactly true", () => {
    const on = checkSSOForm({ ...form, enforce: true }, true);
    expect(on.ok && on.body.enforce).toBe(true);
    const odd = checkSSOForm({ ...form, enforce: "yes" as unknown as boolean }, true);
    expect(odd.ok && odd.body.enforce).toBe(false);
  });
});

describe("enforceState", () => {
  it("needs a saved connection someone signed in through", () => {
    expect(enforceState(null, false)).toMatchObject({ allowed: false, reason: /Save the connection/ });
    expect(enforceState(conn, false)).toMatchObject({ allowed: false, reason: /Sign in through this connection/ });
    expect(enforceState({ ...conn, last_login_at: "2026-11-02T00:00:00Z" }, false)).toEqual({ allowed: true });
  });

  it("stays off once the server answered sso_untested", () => {
    expect(enforceState({ ...conn, last_login_at: "2026-11-02T00:00:00Z" }, true).allowed).toBe(false);
  });

  it("can always turn enforcement off", () => {
    expect(enforceState({ ...conn, enforce: true }, true)).toEqual({ allowed: true });
  });
});

describe("messages", () => {
  it("explains the server's codes", () => {
    expect(ssoError("sso_untested")).toMatch(/Sign in through this connection/);
    expect(ssoError("sso_domain_taken")).toMatch(/Another organization/);
    expect(ssoError("forbidden")).toMatch(/Only owners/);
    expect(ssoError("something_new")).toMatch(/Something went wrong/);
  });

  it("explains a failed test", () => {
    expect(ssoTestError({ error: "bad_status", http_status: 404 })).toMatch(/HTTP 404/);
    expect(ssoTestError({ error: "issuer_mismatch" })).toMatch(/different issuer/);
    expect(ssoTestError({ error: "unreachable" })).toMatch(/couldn’t reach/);
    expect(ssoTestError({})).toMatch(/test failed/);
  });

  it("lists the endpoints discovery found", () => {
    expect(
      discoveredEndpoints({
        ok: true,
        issuer: "https://idp.example.com",
        authorization_endpoint: "https://idp.example.com/authorize",
        token_endpoint: "https://idp.example.com/token",
        jwks_uri: "https://idp.example.com/jwks",
      }),
    ).toEqual([
      { label: "Authorization", value: "https://idp.example.com/authorize" },
      { label: "Token", value: "https://idp.example.com/token" },
      { label: "JWKS", value: "https://idp.example.com/jwks" },
    ]);
  });
});
