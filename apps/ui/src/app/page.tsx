import { redirect } from "next/navigation";
import { getContext, getSession } from "@/lib/auth/server";
import { SIGN_IN_PATH } from "@/lib/auth-gate";
import { identity, isApiError } from "@/lib/identity";
import { landingFor, landingProject, projectHasData } from "@/lib/landing";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";

/**
 * Whether `project` has received any data (`GET /projects/{slug}/apps`: an app an SDK reported
 * for). Undefined when the API could not answer: `/` then opens the home view as before.
 */
async function hasData(project: string): Promise<boolean | undefined> {
  const session = await getSession();
  try {
    const { apps } = await session.call((o) => identity().listManagedApps(project, o));
    return projectHasData(apps);
  } catch (err) {
    if (isSessionExpired(err)) redirectToRefresh("/");
    if (isApiError(err)) return undefined;
    throw err;
  }
}

// `/` routes by session state (#310): signed out → sign-in; signed in without an organization →
// onboarding (at the stored step); otherwise → the last project on the preferred home view, or
// on Settings > SDK setup while that project has no ingested data (#994).
export default async function Home() {
  const session = await getSession();
  if (!session.payload) redirect(SIGN_IN_PATH);
  const ctx = await getContext("/");
  const project = ctx.orgs.length > 0 ? landingProject(ctx) : undefined;
  redirect(landingFor(ctx, project ? await hasData(project.slug) : undefined));
}
