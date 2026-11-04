// Onboarding's 'Invite your team' step (#336): what each address's result reads as once the
// invitations went out, and the sentence for a failed send. The chip input's parsing and checks
// live in invite-input.ts. Pure, so it can be unit tested.
import type { InviteResult, InviteRole, OrgRole } from "./identity";

/** The roles the step's toggle offers for addresses added next; Admin is picked on a chip. */
export const TOGGLE_ROLES: readonly InviteRole[] = ["member", "viewer"];

/** One address's line in the results list. */
export interface InviteOutcome {
  email: string;
  /** "Invitation sent", "Already a member", … */
  label: string;
  tone: "ok" | "muted";
}

/** The results list, in request order. */
export function inviteOutcomes(results: readonly InviteResult[]): InviteOutcome[] {
  return results.map(({ email, status }) => {
    switch (status) {
      case "invited":
        return { email, label: "Invitation sent", tone: "ok" };
      case "replaced":
        return { email, label: "New invitation sent", tone: "ok" };
      case "already_member":
        return { email, label: "Already a member", tone: "muted" };
      case "duplicate":
        return { email, label: "Listed twice, sent once", tone: "muted" };
      default:
        return { email, label: "Not sent", tone: "muted" };
    }
  });
}

/** How many invitations were emailed. */
export function sentCount(results: readonly InviteResult[]): number {
  return results.filter((r) => r.status === "invited" || r.status === "replaced").length;
}

/** The headline over the results list. */
export function outcomeTitle(results: readonly InviteResult[]): string {
  const sent = sentCount(results);
  if (sent === 0) return "No invitations were sent";
  return sent === 1 ? "1 invitation sent" : `${sent} invitations sent`;
}

/** Whether `role` may invite people (the API answers 403 for anyone else). */
export function canInvite(role: OrgRole): boolean {
  return role === "owner" || role === "admin";
}

/** The sentence the step shows for an API error `code`. */
export function inviteError(code: string): string {
  switch (code) {
    case "forbidden":
      return "Only owners and admins can invite people to this organization.";
    case "not_found":
      return "This organization no longer exists, or you’re no longer a member.";
    case "invalid_request":
    case "validation_failed":
    case "bad_request":
      return "Some addresses weren’t accepted. Check them and try again.";
    case "rate_limited":
      return "Too many invitations in a row. Wait a moment and try again.";
    case "network_error":
    case "timeout":
    case "unavailable":
      return "We couldn’t reach APILens. Check your connection and try again.";
    default:
      return "We couldn’t send the invitations. Try again in a moment.";
  }
}
