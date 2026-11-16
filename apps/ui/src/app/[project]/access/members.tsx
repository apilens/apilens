// Access › Members (`/<project>/access`, #806): everyone who can reach the project, their effective
// role and where it comes from (#753 D3). The header and tabs render at once; the list streams in
// behind a skeleton while `GET /projects/{slug}/access` answers.
import { type ReactNode, Suspense, cache } from "react";
import { DefaultAccessCard, RestrictedLabel } from "@/components/access/default-access";
import { AccessMembers, AccessMembersLoading, MembersFrame } from "@/components/access/members";
import { type Candidate, addCandidates } from "@/lib/access-changes";
import { getSession } from "@/lib/auth/server";
import { can } from "@/lib/capabilities";
import { type AccessMember, type DefaultAccess, type Invitation, identity, isApiError } from "@/lib/identity";
import { findProject } from "@/lib/scope";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";
import type { SectionContext } from "../settings/sections/types";

/** The API's largest page. */
const PAGE_LIMIT = 200;
/** A guard against a cursor that never ends: 50 pages of 200 people. */
const MAX_PAGES = 50;

type MembersLoad = { defaultAccess: DefaultAccess; members: AccessMember[] } | null;

/** Every page of `GET /projects/{slug}/access`, unfiltered (the summary counts everyone); null when the API could not answer. */
export async function load({ project, next }: Pick<SectionContext, "project" | "next">): Promise<MembersLoad> {
  const session = await getSession();
  try {
    const members: AccessMember[] = [];
    let cursor: string | undefined;
    let defaultAccess: DefaultAccess = "org_role";
    for (let i = 0; i < MAX_PAGES; i++) {
      const page = await session.call((o) => identity().projectAccess(project, { limit: PAGE_LIMIT, cursor }, o));
      defaultAccess = page.default_access;
      members.push(...(page.members ?? []));
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    return { defaultAccess, members };
  } catch (err) {
    if (isSessionExpired(err)) redirectToRefresh(next);
    if (isApiError(err)) return null;
    throw err;
  }
}

/** One load per request: the list, the default access card and the header's label share it (#808). */
const loadOnce = cache(load);

/**
 * The organization members "Add people" offers (#807): loaded only for holders of `access.manage`;
 * null when the organization's members could not be loaded (the dialog says so).
 */
export async function loadCandidates({ project, context, next }: Pick<SectionContext, "project" | "context" | "next">, access: AccessMember[]): Promise<Candidate[] | null> {
  const org = findProject(context, project)?.org;
  if (!org || !can(context.capabilities, project, "access.manage")) return null;
  const session = await getSession();
  try {
    const members = await session.call((o) => identity().listMembers(org.slug, o));
    return addCandidates(members ?? [], access);
  } catch (err) {
    if (isSessionExpired(err)) redirectToRefresh(next);
    if (isApiError(err)) return null;
    throw err;
  }
}

/**
 * The project's pending invitations (#809), for holders of `access.manage` (the API's rule):
 * undefined without it (the section is left out), null when the API could not answer.
 */
export async function loadInvitations({ project, context, next }: Pick<SectionContext, "project" | "context" | "next">): Promise<Invitation[] | null | undefined> {
  if (!can(context.capabilities, project, "access.manage")) return undefined;
  const session = await getSession();
  try {
    return (await session.call((o) => identity().projectInvitations(project, o))) ?? [];
  } catch (err) {
    if (isSessionExpired(err)) redirectToRefresh(next);
    if (isApiError(err)) return null;
    throw err;
  }
}

async function MembersList({ ctx }: { ctx: SectionContext }) {
  const data = await loadOnce(ctx);
  const [candidates, invitations] = data ? await Promise.all([loadCandidates(ctx, data.members), loadInvitations(ctx)]) : [null, undefined];
  const found = findProject(ctx.context, ctx.project)?.org;
  const orgName = found?.name ?? "the organization";
  const org = { slug: found?.slug ?? "", name: orgName };
  return (
    <>
      {data ? <DefaultAccessCard project={ctx.project} projectName={ctx.projectName} orgName={orgName} defaultAccess={data.defaultAccess} members={data.members} /> : null}
      <AccessMembers project={ctx.project} projectName={ctx.projectName} data={data} params={ctx.search} now={Date.now()} candidates={candidates} org={org} invitations={invitations} />
    </>
  );
}

/** "Restricted" next to the project's name once the list has loaded (#808). */
async function Restricted({ ctx }: { ctx: SectionContext }) {
  const data = await loadOnce(ctx);
  return <RestrictedLabel defaultAccess={data?.defaultAccess ?? null} />;
}

export function render(ctx: SectionContext, nav: ReactNode) {
  return (
    <MembersFrame
      projectName={ctx.projectName}
      nav={nav}
      badge={
        <Suspense fallback={null}>
          <Restricted ctx={ctx} />
        </Suspense>
      }
    >
      <Suspense fallback={<AccessMembersLoading />}>
        <MembersList ctx={ctx} />
      </Suspense>
    </MembersFrame>
  );
}
