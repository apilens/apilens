// Pending invitations (#346): the resend cooldown, expiry and the sentences
// `/orgs/<org>/settings/invitations` shows. The rules mirror internal/controlplane/orgs/invitations.go
// (an invitation is emailed at most once every 5 minutes, counted from `resent_at`, else
// `created_at`) so the Resend button counts down instead of failing; the server stays the
// authority and answers `rate_limited` with `retry_after`. Pure; safe in Client Components and
// Server Actions alike.
//
// Also the invitation landing (`/invite/{token}`, #337): who signs in where, what accepting does
// and how the invited user's onboarding skips the organization and project steps.
import type { ContextOrg, Invitation, InvitationAccepted, UpdateOnboardingRequest, UserContext } from "./identity";
import { homeView } from "./landing";
import { orgHome } from "./scope";

/** The least time between two emails of one invitation (`orgs.ResendCooldown`). */
export const RESEND_COOLDOWN_MS = 5 * 60_000;

/** When `inv` was last emailed. */
export function lastSentAt(inv: Pick<Invitation, "created_at" | "resent_at">): number {
  return Date.parse(inv.resent_at ?? inv.created_at);
}

/** Milliseconds until `inv` can be resent at `now` (0 when it can be now). */
export function resendWait(inv: Pick<Invitation, "created_at" | "resent_at">, now: number): number {
  const last = lastSentAt(inv);
  if (Number.isNaN(last)) return 0;
  return Math.max(0, last + RESEND_COOLDOWN_MS - now);
}

/** A wait as `m:ss`, rounded up to the second (`4:05`, `0:09`). */
export function formatWait(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Whether the emailed link of `inv` stopped working at `now` (it can still be resent). */
export function isExpired(inv: Pick<Invitation, "expires_at">, now: number): boolean {
  const at = Date.parse(inv.expires_at);
  return !Number.isNaN(at) && at <= now;
}

const DAY = new Intl.DateTimeFormat("en", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

/** A day, the same on the server and in every browser. */
export function formatDay(iso: string): string {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? "Unknown" : DAY.format(at);
}

/** Who sent `inv`: their name, their email when they have none, or a dash once they are gone. */
export function inviterName(inv: Pick<Invitation, "invited_by">): string {
  const by = inv.invited_by;
  if (!by) return "—";
  return by.name.trim() || by.email;
}

/** The sentence the invitations page shows for an API error `code`. */
export function invitationsError(code: string): string {
  switch (code) {
    case "invite_expired":
      return "That invitation was already accepted or revoked. The list has been refreshed.";
    case "rate_limited":
      return "That invitation was emailed a moment ago. Wait a few minutes before resending it.";
    case "forbidden":
      return "Only owners and admins can manage invitations.";
    case "not_found":
      return "This organization no longer exists, or you’re no longer a member.";
    case "invalid_request":
    case "validation_failed":
    case "bad_request":
      return "Some values weren’t accepted. Check them and try again.";
    case "network_error":
    case "timeout":
    case "unavailable":
      return "We couldn’t reach APILens. Check your connection and try again.";
    default:
      return "Something went wrong. Try again in a moment.";
  }
}

// --- Invitation landing (#337) ---

/** The onboarding step an invited user starts at (and the only one they see). */
export const INVITED_STEP = "about";
/** Where an invited user with open onboarding goes after accepting. */
export const INVITED_ONBOARDING_PATH = `/onboarding/${INVITED_STEP}`;

/** The landing page of an invitation token. */
export function invitePath(token: string): string {
  return `/invite/${encodeURIComponent(token)}`;
}

/** The Route Handler that accepts an invitation as the signed-in user. */
export function acceptPath(token: string): string {
  return `/api/invitations/${encodeURIComponent(token)}/accept`;
}

/**
 * Where "Accept invitation" sends a signed-out visitor: sign in when this device remembers an
 * account (#314), else sign up. Either way they come back to the invitation afterwards.
 */
export function inviteAuthPath(token: string, remembered: boolean): string {
  return `${remembered ? "/sign-in" : "/sign-up"}?${new URLSearchParams({ next: invitePath(token) })}`;
}

/** Problems the landing shows instead of (or under) the invitation. */
export type InviteProblem = "invite_expired" | "invalid_token" | "invite_email_mismatch" | "error";

/** Maps an identity `code` to the problem the landing shows; anything unknown is `error`. */
export function inviteProblem(code: string | null | undefined): InviteProblem {
  return code === "invite_expired" || code === "invalid_token" || code === "invite_email_mismatch" ? code : "error";
}

/**
 * The organization of an invitation the user accepted while onboarding: the stored
 * `answers.org_slug` names an organization they belong to without owning it (an invitation never
 * makes an owner, while the organization step's create does). Undefined for everyone else.
 */
export function invitedOrg(ctx: UserContext): ContextOrg | undefined {
  if (ctx.onboarding?.completed) return undefined;
  const answers = ctx.onboarding?.answers ?? ctx.user.onboarding?.answers;
  const slug = answers && typeof answers.org_slug === "string" ? answers.org_slug : "";
  if (!slug) return undefined;
  const org = ctx.orgs.find((o) => o.slug === slug);
  return org && org.role !== "owner" ? org : undefined;
}

/** Where an invited user lands once onboarding is done: the organization's first project. */
export function invitedLanding(ctx: UserContext, org: ContextOrg): string {
  return orgHome(org, homeView(ctx));
}

export interface AcceptDeps {
  accept: () => Promise<InvitationAccepted>;
  context: () => Promise<UserContext>;
  updateOnboarding: (patch: UpdateOnboardingRequest) => Promise<unknown>;
}

/**
 * Accepts the invitation and says where the browser goes next. A user still onboarding resumes
 * at the about step with the organization saved (`answers.org_slug`), which marks them as
 * invited: the about step then opens the organization's first project instead of the
 * organization and project steps. A user who finished onboarding goes straight to the
 * organization. Identity errors (`invite_email_mismatch`, `invite_expired`, …) propagate.
 */
export async function acceptInvitation(deps: AcceptDeps): Promise<string> {
  const { org } = await deps.accept();
  const ctx = await deps.context();
  if (!ctx.onboarding?.completed) {
    await deps.updateOnboarding({ step: INVITED_STEP, answers: { org_slug: org.slug } });
    return INVITED_ONBOARDING_PATH;
  }
  const joined = ctx.orgs.find((o) => o.slug === org.slug);
  return joined ? invitedLanding(ctx, joined) : "/";
}

const HOUR_MS = 60 * 60 * 1000;

/** "Expires in 7 days" (to the nearest day), "Expires in 3 hours" (whole hours), "Expires within the hour". */
export function expiresIn(expiresAt: string, now = Date.now()): string {
  const left = Date.parse(expiresAt) - now;
  if (!Number.isFinite(left) || left < HOUR_MS) return "Expires within the hour";
  const hours = Math.floor(left / HOUR_MS);
  if (hours < 24) return `Expires in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(left / (24 * HOUR_MS));
  return `Expires in ${days} day${days === 1 ? "" : "s"}`;
}
