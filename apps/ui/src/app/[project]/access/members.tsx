// Access › Members (`/<project>/access`, #806): everyone who can reach the project, their effective
// role and where it comes from (#753 D3). The header and tabs render at once; the list streams in
// behind a skeleton while `GET /projects/{slug}/access` answers.
import { type ReactNode, Suspense } from "react";
import { AccessMembers, AccessMembersLoading, MembersFrame } from "@/components/access/members";
import { getSession } from "@/lib/auth/server";
import { type AccessMember, type DefaultAccess, identity, isApiError } from "@/lib/identity";
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

async function MembersList({ ctx }: { ctx: SectionContext }) {
  const data = await load(ctx);
  return <AccessMembers project={ctx.project} projectName={ctx.projectName} data={data} params={ctx.search} now={Date.now()} />;
}

export function render(ctx: SectionContext, nav: ReactNode) {
  return (
    <MembersFrame projectName={ctx.projectName} nav={nav}>
      <Suspense fallback={<AccessMembersLoading />}>
        <MembersList ctx={ctx} />
      </Suspense>
    </MembersFrame>
  );
}
