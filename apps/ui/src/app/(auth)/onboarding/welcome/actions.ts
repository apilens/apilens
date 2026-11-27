"use server";

// The Welcome screen's Server Actions: save the name, then join an organization (an invitation,
// a verified-domain match, or one the user already belongs to) or create one with its first
// project. Each one finishes onboarding and answers where the browser goes. A Server Action is a
// public POST endpoint, so every input is checked here, and failures answer a sentence to show.
import { createOrg, createProjectIn } from "@/lib/create-scope";
import { HOME_VIEW } from "@/lib/data";
import { type OnboardingAnswers, type UserContext, identity, isApiError } from "@/lib/identity";
import { invitationsError } from "@/lib/invitations";
import { joinError } from "@/lib/join-org";
import { landingAfterJoin } from "@/lib/landing";
import { saveError, savedAnswers } from "@/lib/onboarding-save";
import { type CreateOrgResult, ORG_SLUG } from "@/lib/org-slug";
import { checkName } from "@/lib/profile";
import { orgHref, projectHref } from "@/lib/routes";
import { type ServerSession, withActionSession } from "@/lib/server-session";
import { FIRST_PROJECT } from "@/lib/welcome";

export type ActionResult = { ok: true } | { ok: false; error: string };
export type JoinResult = { ok: true; href: string } | { ok: false; error: string };
/** Create also answers `projectFailed` when the organization was made but its project was not. */
export type CreateResult = { ok: true; href: string; projectFailed?: boolean } | Extract<CreateOrgResult, { ok: false }>;

/** The step stored once onboarding is finished (`users.OnboardingStepDone`). */
const DONE_STEP = "done";
/** How the messages name an organization when the screen knows only its address. */
const THIS_ORG = "this organization";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Saves the full name on the account (`PATCH /users/me`). */
export async function saveName(name: string): Promise<ActionResult> {
  const checked = checkName(typeof name === "string" ? name : "");
  if (!checked.ok) return checked;
  return withActionSession(async (session) => {
    try {
      await session.call((o) => identity().updateMe({ name: checked.name }, o));
      return { ok: true };
    } catch (err) {
      if (!isApiError(err)) throw err;
      return { ok: false, error: saveError(err.code) };
    }
  });
}

/**
 * Finishes onboarding on the organization the user is now in. A failed save is not a failed
 * sign-up: the organization is theirs either way, so Welcome shows once more rather than
 * reporting a problem the user cannot act on.
 */
async function complete(session: ServerSession, answers: OnboardingAnswers): Promise<void> {
  try {
    await session.call((o) => identity().updateOnboarding({ step: DONE_STEP, completed: true, answers }, o));
  } catch (err) {
    if (!isApiError(err)) throw err;
  }
}

/**
 * Finishes onboarding on `slug` and says where to land: the project an invitation accepted at its
 * emailed link gave a role on (#809, saved as `project_slug`), else the organization's first
 * project, else the organization itself.
 */
async function land(session: ServerSession, ctx: UserContext, slug: string): Promise<JoinResult> {
  const org = ctx.orgs.find((o) => o.slug === slug);
  if (!org) return { ok: false, error: joinError("forbidden", THIS_ORG) };
  const saved = savedAnswers(ctx).project_slug;
  const granted = saved ? org.projects.find((p) => p.slug === saved) : undefined;
  await complete(session, { org_slug: slug });
  return { ok: true, href: granted ? projectHref(granted.slug, HOME_VIEW) : landingAfterJoin(org) };
}

/**
 * Joins the organization `slug` through the user's verified email domain and opens it. One they
 * already belong to is only opened: `POST /orgs/{slug}/join` would answer `forbidden`, and the
 * card for it says "Continue" rather than "Join".
 */
export async function joinOrganization(slug: string): Promise<JoinResult> {
  if (typeof slug !== "string" || !ORG_SLUG.test(slug)) return { ok: false, error: joinError("forbidden", THIS_ORG) };
  return withActionSession(async (session) => {
    try {
      const before = await session.call((o) => identity().context(o));
      if (before.orgs.some((o) => o.slug === slug)) return await land(session, before, slug);
      await session.call((o) => identity().joinOrg(slug, o));
      return await land(session, await session.call((o) => identity().context(o)), slug);
    } catch (err) {
      if (!isApiError(err)) throw err;
      return { ok: false, error: joinError(err.code, THIS_ORG) };
    }
  });
}

/** Accepts the pending invitation `id` and opens the organization it is to. */
export async function acceptInvitation(id: string): Promise<JoinResult> {
  if (typeof id !== "string" || !UUID.test(id)) return { ok: false, error: invitationsError("invite_expired") };
  return withActionSession(async (session) => {
    try {
      const org = await session.call((o) => identity().acceptMyInvitation(id, o));
      return await land(session, await session.call((o) => identity().context(o)), org.slug);
    } catch (err) {
      if (!isApiError(err)) throw err;
      // 409 `invitation_not_pending` (already accepted, revoked or expired) and 404 (someone
      // else's, or gone) both mean the card is stale; the screen reloads the list with the message.
      if (err.code === "invitation_not_pending" || err.status === 404) return { ok: false, error: invitationsError("invite_expired") };
      return { ok: false, error: joinError(err.code, THIS_ORG) };
    }
  });
}

/**
 * Creates the organization and its first project, then finishes onboarding. A failed project is
 * not a failed sign-up: the organization exists, so the user lands on it and its empty state
 * offers "Create your first project".
 */
export async function createOrganization(name: string, slug: string): Promise<CreateResult> {
  const org = await createOrg(name, slug);
  if (!org.ok) return org;
  const envs = [...FIRST_PROJECT.environments];
  let project = await createProjectIn(org.slug, FIRST_PROJECT.name, FIRST_PROJECT.slug, envs);
  // Project addresses are unique per deployment (the `projects_slug_active` index is on `slug`
  // alone), so only the first organization ever created gets `my-api`: everyone after it takes the
  // first address the API offers, under the same name. A second failure keeps the path below.
  if (!project.ok && "suggestions" in project && project.suggestions[0]) {
    project = await createProjectIn(org.slug, FIRST_PROJECT.name, project.suggestions[0], envs);
  }
  const answers: OnboardingAnswers = project.ok ? { org_slug: org.slug, project_slug: project.slug } : { org_slug: org.slug };
  await withActionSession((session) => complete(session, answers));
  if (!project.ok) return { ok: true, href: orgHref(org.slug), projectFailed: true };
  return { ok: true, href: projectHref(project.slug, HOME_VIEW) };
}
