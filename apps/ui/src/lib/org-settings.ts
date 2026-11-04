// Organization settings (#347): the rules the `/orgs/<org>/settings` form checks before it calls
// `PATCH /orgs/{slug}` or `DELETE /orgs/{slug}`, and the sentences it shows for the server's
// error codes. The server stays the authority (public email domains answer `domain_not_allowed`
// and only it knows that list); these checks only spare a round trip. Pure; safe in Client
// Components and Server Actions alike.
import type { OrgRole } from "./identity";

/** Longest organization name the API accepts (`maxLength` of `name`). */
export const MAX_ORG_NAME = 100;
/** Most allowed email domains an organization can list (`maxItems` of `allowed_domains`). */
export const MAX_ALLOWED_DOMAINS = 50;

// Mirrors `hostnameRE` in internal/controlplane/orgs/manage.go: lower-case labels joined by dots,
// at least two labels, the last one starting with a letter.
const HOSTNAME = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Owners and admins change the settings (`org.manage`); members and viewers only read them. */
export function canManageOrg(role: OrgRole): boolean {
  return role === "owner" || role === "admin";
}

/** Only owners delete the organization. */
export function canDeleteOrg(role: OrgRole): boolean {
  return role === "owner";
}

/** The name as it will be saved, or why it cannot be. */
export function checkOrgName(raw: string): { ok: true; name: string } | { ok: false; error: string } {
  const name = raw.trim();
  if (!name) return { ok: false, error: "Enter a name." };
  if ([...name].length > MAX_ORG_NAME) return { ok: false, error: `Use at most ${MAX_ORG_NAME} characters.` };
  return { ok: true, name };
}

/**
 * What someone typed or pasted as a domain, the way the API stores it: lower-case, no
 * surrounding spaces, no leading `@` or `*.`, no scheme, path or trailing dot. `@Acme.com`,
 * `https://acme.com/` and `acme.com.` all become `acme.com`.
 */
export function normalizeDomain(raw: string): string {
  let d = raw.trim().toLowerCase();
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  d = d.replace(/[/?#].*$/, "");
  d = d.replace(/^.*@/, "").replace(/^\*\./, "");
  return d.replace(/\.+$/, "");
}

/** Whether `domain` (already normalized) is a hostname the API accepts. */
export function isValidDomain(domain: string): boolean {
  return domain.length <= 253 && HOSTNAME.test(domain);
}

/** Splits pasted text (`acme.com, acme.io  acme.dev`) into the entries it holds. */
export function splitDomains(text: string): string[] {
  return text.split(/[\s,;]+/).filter(Boolean);
}

export type AddDomainsResult = { domains: string[]; error: string | null };

/**
 * Adds the typed or pasted `input` to `current`. Valid new domains are appended (duplicates are
 * dropped); the first entry that cannot be added is reported, and nothing from `input` is added
 * in that case so the person can correct it in place.
 */
export function addDomains(current: readonly string[], input: string): AddDomainsResult {
  const entries = splitDomains(input);
  const next = [...current];
  for (const entry of entries) {
    const domain = normalizeDomain(entry);
    if (!isValidDomain(domain)) {
      return { domains: [...current], error: `“${entry}” isn’t a domain. Use a hostname like acme.com.` };
    }
    if (!next.includes(domain)) next.push(domain);
  }
  if (next.length > MAX_ALLOWED_DOMAINS) {
    return { domains: [...current], error: `An organization can list at most ${MAX_ALLOWED_DOMAINS} domains.` };
  }
  return { domains: next, error: null };
}

/** Checks a whole list before it is sent (what a Server Action receives from the browser). */
export function checkDomains(list: unknown): { ok: true; domains: string[] } | { ok: false; error: string } {
  if (!Array.isArray(list) || list.some((d) => typeof d !== "string")) {
    return { ok: false, error: "Enter domains like acme.com." };
  }
  const { domains, error } = addDomains([], (list as string[]).join(" "));
  return error ? { ok: false, error } : { ok: true, domains };
}

/** Whether the delete confirmation matches: the slug exactly, ignoring surrounding spaces. */
export function deleteConfirmed(slug: string, typed: string): boolean {
  return typed.trim() === slug;
}

/** The sentence the settings page shows for an API error `code`. */
export function orgSettingsError(code: string): string {
  switch (code) {
    case "domain_not_allowed":
      return "Public email domains like gmail.com or outlook.com can’t be claimed by an organization. Remove them and save again.";
    case "slug_immutable":
      return "The address can’t be changed yet.";
    case "invalid_request":
    case "validation_failed":
    case "bad_request":
      return "Some values weren’t accepted. Check them and try again.";
    case "forbidden":
      return "You don’t have permission to change this organization.";
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

/** A page of the organization settings, shown as a tab under the title. */
export interface OrgSettingsSection {
  /** URL segment under `/orgs/<org>/settings`; empty for General. */
  slug: string;
  label: string;
}

export const ORG_SETTINGS_SECTIONS: readonly OrgSettingsSection[] = [
  { slug: "", label: "General" },
  { slug: "members", label: "Members" },
  { slug: "invitations", label: "Invitations" },
];

/** `/orgs/<org>/settings` or `/orgs/<org>/settings/<slug>`. */
export function orgSettingsHref(org: string, section: Pick<OrgSettingsSection, "slug">): string {
  return section.slug ? `/orgs/${org}/settings/${section.slug}` : `/orgs/${org}/settings`;
}
