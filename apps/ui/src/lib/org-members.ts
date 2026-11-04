// Organization members (#345): who may do what on `/orgs/<org>/settings/members`, the reason a
// control is disabled, the invite dialog's address parsing and the sentences shown for the
// server's error codes. Permissions come from the backend's capabilities (`members.invite`,
// `members.remove`); the rules below only mirror the API's extra checks (owners only touch
// owners, the last owner stays) so a control is disabled with its reason instead of failing.
// The server stays the authority. Pure; safe in Client Components and Server Actions alike.
import { type Action, can } from "./capabilities";
import type { InviteResult, InviteRole, Member, OrgRole, UserContext } from "./identity";

/** Every role, most powerful first (the role select's order). */
export const MEMBER_ROLES: readonly OrgRole[] = ["owner", "admin", "member", "viewer"];

/** The roles an invitation can carry. */
export const INVITE_ROLES: readonly InviteRole[] = ["admin", "member", "viewer"];

/** Most addresses one invite request takes (`maxItems` of `invites`). */
export const MAX_INVITES = 50;

/** One line on what each role can do. */
export const ROLE_SUMMARY: Record<OrgRole, string> = {
  owner: "Everything, including billing, deleting the organization and transferring ownership.",
  admin: "Manage members, invitations, settings and every project.",
  member: "Work in every project: create keys and change project settings.",
  viewer: "Read-only access to every project.",
};

/**
 * Whether the user may perform an organization-level `action` (`members.invite`,
 * `members.remove`, `billing.manage`) in organization `orgSlug`. The context lists capabilities
 * per project, and organization actions are checked on the project's organization, so any
 * project of the organization answers. An organization without projects has no capabilities
 * yet; then the role decides, the way the API's `organization#invite` and `#manage_members`
 * permissions do (owners and admins).
 */
export function orgCan(ctx: UserContext, orgSlug: string, action: Action): boolean {
  const org = ctx.orgs.find((o) => o.slug === orgSlug);
  if (!org) return false;
  if (org.projects.length > 0) return org.projects.some((p) => can(ctx.capabilities, p.slug, action));
  if (action === "members.invite" || action === "members.remove") return org.role === "owner" || org.role === "admin";
  return false;
}

/** The signed-in user as the members page sees them. */
export interface Viewer {
  /** Their user id, to find their own row. */
  id: string;
  role: OrgRole;
  /** `members.remove`: change roles and remove members. */
  manage: boolean;
  /** `members.invite`: open the invite dialog. */
  invite: boolean;
}

/** Allowed, or why not (shown as the disabled control's tooltip). */
export type Gate = { allowed: true } | { allowed: false; reason: string };

const ALLOWED: Gate = { allowed: true };
const deny = (reason: string): Gate => ({ allowed: false, reason });

/** How many owners `members` has. */
export function ownerCount(members: readonly Member[]): number {
  return members.filter((m) => m.role === "owner").length;
}

/** Whether `viewer` may change `member`'s role. */
export function roleGate(viewer: Viewer, member: Member, owners: number): Gate {
  if (!viewer.manage) return deny("Only owners and admins can change roles.");
  if (member.user.id === viewer.id) return deny("You can’t change your own role.");
  if (member.role === "owner" && viewer.role !== "owner") return deny("Only owners can change an owner’s role.");
  if (member.role === "owner" && owners <= 1) return deny("An organization needs at least one owner.");
  return ALLOWED;
}

/** Whether `viewer` may pick `role` for someone (only owners make owners). */
export function roleOptionAllowed(viewer: Viewer, role: OrgRole): boolean {
  return role !== "owner" || viewer.role === "owner";
}

/** Whether `viewer` may remove `member` from the organization. */
export function removeGate(viewer: Viewer, member: Member, owners: number): Gate {
  if (!viewer.manage) return deny("Only owners and admins can remove members.");
  if (member.user.id === viewer.id) return deny("You can’t remove yourself.");
  if (member.role === "owner" && viewer.role !== "owner") return deny("Only owners can remove an owner.");
  if (member.role === "owner" && owners <= 1) return deny("An organization needs at least one owner.");
  return ALLOWED;
}

/** Whether `viewer` may open the invite dialog. */
export function inviteGate(viewer: Viewer): Gate {
  return viewer.invite ? ALLOWED : deny("Only owners and admins can invite people.");
}

/** The members ownership can go to: everyone except the viewer and those already owners. */
export function transferCandidates(viewer: Viewer, members: readonly Member[]): Member[] {
  return members.filter((m) => m.user.id !== viewer.id && m.role !== "owner");
}

/** Whether `viewer` may transfer ownership. */
export function transferGate(viewer: Viewer, members: readonly Member[]): Gate {
  if (viewer.role !== "owner") return deny("Only owners can transfer ownership.");
  if (transferCandidates(viewer, members).length === 0) return deny("Invite someone first. There’s no one to transfer ownership to.");
  return ALLOWED;
}

/** The name to show: the member's name, or their email when they have none. */
export function memberName(m: Member): string {
  return m.user.name.trim() || m.user.email;
}

/** Up to two initials for the avatar. */
export function memberInitials(m: Member): string {
  const name = m.user.name.trim();
  if (name) {
    const parts = name.split(/\s+/);
    const two = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0].slice(0, 2);
    return two.toUpperCase();
  }
  return (m.user.email[0] ?? "?").toUpperCase();
}

/** The day someone joined, the same on the server and in every browser. */
export function formatJoined(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "Unknown";
  return new Intl.DateTimeFormat("en", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(at);
}

// A pragmatic address check: something@label.tld, no spaces. The API validates for real.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Whether `email` looks like an address worth sending. */
export function isEmail(email: string): boolean {
  return email.length <= 320 && EMAIL.test(email);
}

export type ParsedInvites = { emails: string[]; invalid: string[] };

/**
 * The addresses typed or pasted into the invite dialog (`a@example.com, b@example.com` or one
 * per line): lower-cased, duplicates dropped, in the order given; the entries that are not
 * addresses are returned apart so the dialog can name them.
 */
export function parseInviteEmails(text: string): ParsedInvites {
  const emails: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const entry = raw.replace(/^<|>$/g, "").trim();
    if (!entry) continue;
    const email = entry.toLowerCase();
    if (!isEmail(email)) invalid.push(entry);
    else if (!emails.includes(email)) emails.push(email);
  }
  return { emails, invalid };
}

/** What the dialog says once the invitations went out. */
export function inviteSummary(results: readonly InviteResult[]): string {
  const sent = results.filter((r) => r.status === "invited" || r.status === "replaced").length;
  const members = results.filter((r) => r.status === "already_member").map((r) => r.email);
  const parts: string[] = [];
  if (sent > 0) parts.push(`Sent ${sent === 1 ? "1 invitation" : `${sent} invitations`}.`);
  if (members.length > 0) parts.push(`${members.join(", ")} ${members.length === 1 ? "is already a member" : "are already members"}.`);
  return parts.join(" ") || "No invitations were sent.";
}

/** The sentence the members page shows for an API error `code`. */
export function membersError(code: string): string {
  switch (code) {
    case "last_owner":
      return "An organization needs at least one owner. Make someone else an owner first.";
    case "member_gone":
      return "That person is no longer a member. The list has been refreshed.";
    case "forbidden":
      return "You don’t have permission to do that.";
    case "not_found":
      return "This organization no longer exists, or you’re no longer a member.";
    case "invalid_request":
    case "validation_failed":
    case "bad_request":
      return "Some values weren’t accepted. Check them and try again.";
    case "rate_limited":
      return "Too many changes in a row. Wait a moment and try again.";
    case "authz_unavailable":
    case "network_error":
    case "timeout":
    case "unavailable":
      return "We couldn’t reach APILens. Check your connection and try again.";
    default:
      return "Something went wrong. Try again in a moment.";
  }
}
