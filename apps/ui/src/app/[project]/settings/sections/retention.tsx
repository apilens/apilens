// Project settings › Retention (#818): the header and the operator note render at once; the
// periods stream in behind a skeleton while `GET /projects/{slug}/retention` answers.
import { Suspense } from "react";
import { RetentionFrame, type RetentionLoad, RetentionLoading, RetentionTable } from "@/components/project-settings/retention";
import { getSession } from "@/lib/auth/server";
import { identity, isApiError } from "@/lib/identity";
import { retentionError } from "@/lib/retention";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";
import type { SectionContext } from "./types";

/** `GET /projects/{slug}/retention`, or the sentence for its error code. */
async function fetchRetention({ project, next }: SectionContext): Promise<RetentionLoad> {
  const session = await getSession();
  try {
    return await session.call((o) => identity().projectRetention(project, o));
  } catch (err) {
    if (isSessionExpired(err)) redirectToRefresh(next);
    if (isApiError(err)) return { error: retentionError(err.code) };
    throw err;
  }
}

/** Nothing loads up front: the table loads inside its Suspense boundary so the page shows a skeleton. */
export async function load(): Promise<null> {
  return null;
}

async function Periods({ ctx }: { ctx: SectionContext }) {
  return <RetentionTable data={await fetchRetention(ctx)} />;
}

export function render(_: null, ctx: SectionContext) {
  return (
    <RetentionFrame project={ctx.project} projectName={ctx.projectName}>
      <Suspense fallback={<RetentionLoading />}>
        <Periods ctx={ctx} />
      </Suspense>
    </RetentionFrame>
  );
}
