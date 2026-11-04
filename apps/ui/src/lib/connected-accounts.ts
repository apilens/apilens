// Settings → Connected accounts (#344): the Google and GitHub accounts a user can sign in with,
// besides their email. Connecting runs identity's OAuth flow with `intent=link`; identity sends the
// browser back here with `?linked=<provider>`, or to `/sign-in?error=<code>` when it fails, which
// the auth gate turns into `?error=<code>` on this page for a signed-in user.
//
// Pure; safe in Client Components and in the edge proxy.
import type { ConnectedAccount } from "./identity";
import type { OAuthProvider, SignInMethods } from "./sign-in-methods";

/** The section's page; identity returns the browser here after connecting an account. */
export const CONNECTED_ACCOUNTS_PATH = "/settings/connected-accounts";

export const OAUTH_PROVIDERS: readonly { id: OAuthProvider; label: string }[] = [
  { id: "google", label: "Google" },
  { id: "github", label: "GitHub" },
];

export function providerLabel(provider: string): string {
  return OAUTH_PROVIDERS.find((p) => p.id === provider)?.label ?? provider;
}

export function isOAuthProvider(value: unknown): value is OAuthProvider {
  return OAUTH_PROVIDERS.some((p) => p.id === value);
}

/** One provider on the page: whether this deployment offers it and the accounts connected through it. */
export interface ProviderRow {
  provider: OAuthProvider;
  label: string;
  /** False when the deployment has no keys for it: nothing new can be connected. */
  available: boolean;
  accounts: ConnectedAccount[];
}

/**
 * Every provider, in display order, with its connected accounts (oldest first, as listed). A
 * provider the deployment does not offer still shows, so an account connected earlier can be
 * disconnected.
 */
export function providerRows(methods: Pick<SignInMethods, OAuthProvider>, accounts: readonly ConnectedAccount[]): ProviderRow[] {
  return OAUTH_PROVIDERS.map(({ id, label }) => ({
    provider: id,
    label,
    available: methods[id],
    accounts: accounts.filter((a) => a.provider === id),
  }));
}

/** How a connected account is named: the GitHub login, else the email, else the display name. */
export function accountName(a: Pick<ConnectedAccount, "provider" | "username" | "email" | "name">): string {
  if (a.username) return `@${a.username}`;
  return a.email || a.name || `${providerLabel(a.provider)} account`;
}

const DATE = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

/** "Mar 4, 2026" for an RFC 3339 timestamp (UTC, so server and browser agree); "" when unparsable. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : DATE.format(t);
}

export type ConnectedNoticeTone = "ok" | "error";

export interface ConnectedNotice {
  code: string;
  tone: ConnectedNoticeTone;
  text: string;
}

/**
 * Failed connections that identity reports on `/sign-in?error=`. A signed-in user cannot start a
 * social sign-in, so landing there with one of these means a connect attempt failed: the auth
 * gate brings them back here instead of bouncing them to `/`.
 */
export const LINK_ERROR_NOTICES: Record<string, string> = {
  oauth_identity_taken:
    "That account is already connected to a different APILens account. Sign in to that account and disconnect it there first, or connect another one.",
  oauth_denied: "The connection was cancelled at the provider. Nothing changed.",
  oauth_state_mismatch: "The connection timed out or was opened twice. Try connecting again.",
  oauth_email_unverified: "That account has no verified email. Verify it with the provider, then try again.",
};

/** Shown for any other `?error=` value. */
const GENERIC_LINK_ERROR = "The account couldn’t be connected. Try again.";

const CODE = /^[a-z0-9_]{1,64}$/;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * The banner for this page's query. `?error=` wins over `?linked=`. Query values never reach the
 * page as text: each selects one of the fixed sentences.
 */
export function connectedNotice(params: { linked?: string | string[]; error?: string | string[] }): ConnectedNotice | null {
  const error = first(params.error);
  if (error) {
    const known = CODE.test(error) && Object.hasOwn(LINK_ERROR_NOTICES, error);
    return { code: known ? error : "unknown", tone: "error", text: known ? LINK_ERROR_NOTICES[error] : GENERIC_LINK_ERROR };
  }
  const linked = first(params.linked);
  if (isOAuthProvider(linked)) {
    return { code: "linked", tone: "ok", text: `${providerLabel(linked)} account connected. You can now sign in with it.` };
  }
  return null;
}

/** The current URL with `linked` and `error` removed, so a dismissed banner stays gone on reload. */
export function withoutConnectedParams(href: string): string {
  const url = new URL(href, "http://x");
  url.searchParams.delete("linked");
  url.searchParams.delete("error");
  const q = url.searchParams.toString();
  return `${url.pathname}${q ? `?${q}` : ""}${url.hash}`;
}

/** The sentence a failed connect or disconnect shows for identity's error `code`. */
export function connectedAccountsError(code: string): string {
  switch (code) {
    case "not_found":
      return "This sign-in provider isn’t available on this server.";
    case "oauth_identity_gone":
      return "That account was already disconnected.";
    case "rate_limited":
      return "Too many attempts. Wait a minute, then try again.";
    case "network_error":
    case "timeout":
      return "Couldn’t reach the server. Check your connection and try again.";
    default:
      return "Something went wrong. Try again.";
  }
}
