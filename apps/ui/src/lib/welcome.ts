// The one onboarding screen (#326): the organization choices it offers and the first project it
// creates. Pure, so the cross-checks can be unit tested; the Welcome page and its Server Actions
// apply them.
import type { JoinableOrg, MyInvitation, UserContext } from "./identity";
import { slugify } from "./org-slug";

/** The project created with a new organization; its ingest key is minted by the first-run guide. */
export const FIRST_PROJECT = { name: "my-api", slug: "my-api", environments: ["production"] } as const;

/**
 * The organization name Welcome prefills: "Ada's org" from "Ada Lovelace", "" without a name and
 * "" for a first name `slugify` leaves nothing of (CJK, Cyrillic, Arabic, emoji) — its address
 * would come from the possessive alone (`s-org`), and an organization's address is immutable.
 */
export function suggestedOrgName(fullName: string): string {
  const [word = ""] = fullName.trim().split(/\s+/);
  if (!word || !slugify(word)) return "";
  const first = word[0].toUpperCase() + word.slice(1);
  return `${first}${first.toLowerCase().endsWith("s") ? "'" : "'s"} org`;
}

/** An organization Welcome offers, in the order the screen shows them. */
export type WelcomeCard =
  /** Already a member (an invitation accepted at its link, or a second sign-in): continue into it. */
  | { kind: "member"; slug: string; name: string }
  | { kind: "invitation"; id: string; slug: string; name: string; role: MyInvitation["role"]; invitedBy: string }
  | { kind: "domain"; slug: string; name: string; memberCount: number; projectCount: number; initials: string[] };

/**
 * One card per organization: the invitations waiting for the user's address first (someone asked
 * them to act), then the organizations they already belong to, then the verified-domain matches.
 * `listMyInvitations` neither excludes organizations the user already belongs to nor merges two
 * invitations to the same one (addresses are trimmed, not lower-cased), so both are dropped here:
 * an organization never shows twice, and joining one the user is already in is never offered.
 */
export function welcomeCards(ctx: UserContext, invitations: readonly MyInvitation[], joinable: readonly JoinableOrg[]): WelcomeCard[] {
  const seen = new Set(ctx.orgs.map((o) => o.slug));
  const invited: WelcomeCard[] = [];
  const domains: WelcomeCard[] = [];

  for (const inv of invitations) {
    if (seen.has(inv.org_slug)) continue;
    seen.add(inv.org_slug);
    invited.push({ kind: "invitation", id: inv.id, slug: inv.org_slug, name: inv.org_name, role: inv.role, invitedBy: inv.invited_by_name });
  }
  for (const org of joinable) {
    if (seen.has(org.slug)) continue;
    seen.add(org.slug);
    domains.push({ kind: "domain", slug: org.slug, name: org.name, memberCount: org.member_count, projectCount: org.project_count, initials: org.member_initials });
  }
  const members: WelcomeCard[] = ctx.orgs.map((o) => ({ kind: "member", slug: o.slug, name: o.name }));
  return [...invited, ...members, ...domains];
}
