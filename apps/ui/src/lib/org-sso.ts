// Organization single sign-on (#348): the rules the `/orgs/<org>/settings/sso` form checks before
// it calls `PUT /orgs/{slug}/sso`, and the sentences it shows for the server's error codes and
// for a failed connection test. The server stays the authority (it alone knows which domains are
// public providers, which ones another organization enforces, and whether the caller has signed
// in through the connection); these checks only spare a round trip. Pure; safe in Client
// Components and Server Actions alike.
import type { OrgRole, PutSSORequest, SSOConnection, SSODefaultRole, SSOTestResult } from "./identity";
import { addDomains } from "./org-settings";

/** What reads show for the write-only client secret (`orgs.SSOSecretMask`). */
export const SSO_SECRET_MASK = "********";

/** Longest issuer URL, client id and client secret the API accepts. */
export const MAX_SSO_ISSUER = 2048;
export const MAX_SSO_CLIENT_ID = 255;
export const MAX_SSO_CLIENT_SECRET = 1024;

/** Roles a user can get from their first SSO sign-in, most privileged first. */
export const SSO_DEFAULT_ROLES: readonly SSODefaultRole[] = ["admin", "member", "viewer"];

/** Only owners read or change the SSO connection (the API answers 403 to anyone else). */
export function canManageSSO(role: OrgRole): boolean {
  return role === "owner";
}

function isLoopback(host: string): boolean {
  if (host === "localhost") return true;
  if (/^127(\.\d{1,3}){3}$/.test(host)) return true;
  return host === "[::1]";
}

/**
 * Why `issuer` cannot be an OIDC issuer, or null when it can. Mirrors `orgs.ValidSSOIssuer`: an
 * absolute https URL without query, fragment or credentials, or http on a loopback host.
 */
export function issuerProblem(issuer: string): string | null {
  if (!issuer) return "Enter the issuer URL of your identity provider.";
  if (issuer.length > MAX_SSO_ISSUER) return `Use at most ${MAX_SSO_ISSUER} characters.`;
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return "Enter a full URL, like https://login.example.com.";
  }
  if (!url.host) return "Enter a full URL, like https://login.example.com.";
  if (url.username || url.password || url.search || url.hash || issuer.includes("?") || issuer.includes("#")) {
    return "Use the issuer URL without credentials, query or fragment.";
  }
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && isLoopback(url.hostname)) return null;
  return "The issuer must use https.";
}

/** What the form holds. `clientSecret` is empty when the stored one should be kept. */
export interface SSOForm {
  issuer: string;
  clientId: string;
  clientSecret: string;
  domains: readonly string[];
  defaultRole: string;
  enforce: boolean;
}

export type SSOField = "issuer" | "clientId" | "clientSecret" | "domains" | "defaultRole";

export type CheckedSSOForm = { ok: true; body: PutSSORequest } | { ok: false; field: SSOField; error: string };

/**
 * The `PUT /orgs/{slug}/sso` body for `form`, or the first field that cannot be saved. `existing`
 * says whether a connection is already saved (a new one needs a client secret).
 */
export function checkSSOForm(form: SSOForm, existing: boolean): CheckedSSOForm {
  const issuer = typeof form.issuer === "string" ? form.issuer.trim() : "";
  const issuerError = issuerProblem(issuer);
  if (issuerError) return { ok: false, field: "issuer", error: issuerError };

  const clientId = typeof form.clientId === "string" ? form.clientId.trim() : "";
  if (!clientId) return { ok: false, field: "clientId", error: "Enter the client ID your identity provider issued." };
  if (clientId.length > MAX_SSO_CLIENT_ID) return { ok: false, field: "clientId", error: `Use at most ${MAX_SSO_CLIENT_ID} characters.` };

  const secret = typeof form.clientSecret === "string" ? form.clientSecret.trim() : "";
  if (!secret && !existing) return { ok: false, field: "clientSecret", error: "Enter the client secret your identity provider issued." };
  if (secret.length > MAX_SSO_CLIENT_SECRET) {
    return { ok: false, field: "clientSecret", error: `Use at most ${MAX_SSO_CLIENT_SECRET} characters.` };
  }

  if (!Array.isArray(form.domains) || form.domains.some((d) => typeof d !== "string")) {
    return { ok: false, field: "domains", error: "Enter domains like acme.com." };
  }
  const { domains, error } = addDomains([], form.domains.join(" "));
  if (error) return { ok: false, field: "domains", error };
  if (domains.length === 0) return { ok: false, field: "domains", error: "Add at least one email domain." };

  if (!SSO_DEFAULT_ROLES.includes(form.defaultRole as SSODefaultRole)) {
    return { ok: false, field: "defaultRole", error: "Pick a role." };
  }

  const body: PutSSORequest = {
    issuer,
    client_id: clientId,
    domains,
    enforce: form.enforce === true,
    default_role: form.defaultRole as SSODefaultRole,
  };
  // Leaving the secret out (or sending the mask back) keeps the stored one.
  if (secret && secret !== SSO_SECRET_MASK) body.client_secret = secret;
  return { ok: true, body };
}

export type EnforceState = { allowed: true } | { allowed: false; reason: string };

/**
 * Whether the "Require SSO" switch can be turned on. The server only accepts it once the caller
 * has signed in through the saved connection (`sso_untested`); `untested` is true after it said
 * so. A switch that is already on can always be turned off.
 */
export function enforceState(conn: SSOConnection | null, untested: boolean): EnforceState {
  if (conn?.enforce) return { allowed: true };
  if (!conn) return { allowed: false, reason: "Save the connection first, then sign in through it once to prove it works." };
  if (untested || !conn.last_login_at) {
    return {
      allowed: false,
      reason: "Sign in through this connection once to prove it works. Until then, requiring SSO could lock everyone out, you included.",
    };
  }
  return { allowed: true };
}

/** The sentence the SSO page shows for an API error `code`. */
export function ssoError(code: string): string {
  switch (code) {
    case "sso_untested":
      return "Sign in through this connection once before requiring it, so nobody gets locked out.";
    case "sso_domain_taken":
      return "Another organization already requires SSO for one of these domains. Remove it and save again.";
    case "sso_not_configured":
      return "This organization has no SSO connection anymore. Reload the page.";
    case "domain_not_allowed":
      return "Public email domains like gmail.com or outlook.com can’t sign in through SSO. Remove them and save again.";
    case "invalid_request":
    case "validation_failed":
    case "bad_request":
      return "Some values weren’t accepted. Check the issuer, client ID, secret and domains and try again.";
    case "forbidden":
      return "Only owners can manage single sign-on.";
    case "not_found":
      return "This organization no longer exists, or you’re no longer a member.";
    case "rate_limited":
      return "Too many changes in a row. Wait a moment and try again.";
    case "network_error":
    case "timeout":
    case "unavailable":
      return "We couldn’t reach APILens. Check your connection and try again.";
    default:
      return "Something went wrong. Try again in a moment.";
  }
}

/** What a failed connection test means, in a sentence. */
export function ssoTestError(result: Pick<SSOTestResult, "error" | "http_status">): string {
  switch (result.error) {
    case "unreachable":
      return "We couldn’t reach the issuer’s discovery document. Check the URL and that it’s reachable from APILens.";
    case "bad_status":
      return `The discovery document answered with HTTP ${result.http_status ?? "an error"}. Check the issuer URL.`;
    case "invalid_document":
      return "The discovery document isn’t valid OpenID Connect metadata.";
    case "issuer_mismatch":
      return "The discovery document names a different issuer. Use the issuer URL exactly as your provider states it.";
    case "missing_endpoints":
      return "The discovery document lacks the authorization, token or JWKS endpoint sign-in needs.";
    default:
      return "The test failed. Check the issuer URL and try again.";
  }
}

/** The endpoints a successful test discovered, as label and URL rows (empty ones left out). */
export function discoveredEndpoints(result: SSOTestResult): { label: string; value: string }[] {
  const rows: { label: string; value: string | undefined }[] = [
    { label: "Authorization", value: result.authorization_endpoint },
    { label: "Token", value: result.token_endpoint },
    { label: "User info", value: result.userinfo_endpoint },
    { label: "JWKS", value: result.jwks_uri },
  ];
  return rows.filter((r): r is { label: string; value: string } => typeof r.value === "string" && r.value !== "");
}
