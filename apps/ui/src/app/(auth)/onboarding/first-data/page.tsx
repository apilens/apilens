import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { FirstDataScreen } from "@/components/onboarding/first-data";
import { requireOnboardingStep } from "@/lib/auth/onboarding";
import { getContext, getSession } from "@/lib/auth/server";
import { ENDPOINT_LIMIT, FIRST_DATA_RANGE, FIRST_DATA_ROWS, type FirstData, loadFirstData } from "@/lib/first-data";
import { identity, isApiError } from "@/lib/identity";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";

export const metadata: Metadata = { title: "Your first requests" };

const PATH = "/onboarding/first-data";

/**
 * The latest requests, the endpoint count and the p95 from the query API as the signed-in user
 * (`?project=`, #295), or null when it could not answer.
 */
async function load(project: string): Promise<FirstData | null> {
  const session = await getSession();
  try {
    return await loadFirstData({
      requests: () => session.call((o) => identity().listRequests(project, { range: FIRST_DATA_RANGE, limit: FIRST_DATA_ROWS }, o)),
      summary: () => session.call((o) => identity().trafficSummary(project, FIRST_DATA_RANGE, o)),
      endpoints: () => session.call((o) => identity().listEndpoints(project, { range: FIRST_DATA_RANGE, limit: ENDPOINT_LIMIT }, o)),
    });
  } catch (err) {
    if (isSessionExpired(err)) redirectToRefresh(PATH);
    if (isApiError(err)) return null;
    throw err;
  }
}

export default async function Page() {
  const { step, reached, answers } = await requireOnboardingStep("first-data");
  // Cached per request: the guard above already loaded it.
  const ctx = await getContext(PATH);
  const project = ctx.orgs.flatMap((o) => o.projects).find((p) => p.slug === answers.project_slug);
  // No project to show yet: create one first.
  if (!project) redirect("/onboarding/project");
  const data = await load(project.slug);
  return (
    <FirstDataScreen
      step={step}
      reached={reached}
      project={{ slug: project.slug, name: project.name }}
      data={data}
      // The relative times are computed from the load, so server and browser render the same text.
      loadedAt={Date.now()}
    />
  );
}
