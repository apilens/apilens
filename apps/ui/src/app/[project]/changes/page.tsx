import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ChangesView } from "@/components/changes/changes";
import { getContext, getSession } from "@/lib/auth/server";
import { CHANGES_LIMIT, CHANGES_RANGE } from "@/lib/changes";
import { type DeployChange, identity, isApiError } from "@/lib/identity";
import { findProject } from "@/lib/scope";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";

export const metadata: Metadata = { title: "Changes" };

/** `GET /deploys/changes` as the signed-in user, or null when the query API could not answer. */
async function loadChanges(project: string, next: string): Promise<DeployChange[] | null> {
  const session = await getSession();
  try {
    const res = await session.call((o) => identity().deployChanges(project, { range: CHANGES_RANGE, limit: CHANGES_LIMIT }, o));
    return res?.deploys ?? [];
  } catch (err) {
    if (isSessionExpired(err)) redirectToRefresh(next);
    if (isApiError(err)) return null;
    throw err;
  }
}

// Changes (#597): deploys with their before/after error rate and p95.
export default async function ChangesPage({ params }: { params: Promise<{ project: string }> }) {
  const { project } = await params;
  const next = `/${project}/changes`;
  const context = await getContext(next);
  const found = findProject(context, project);
  if (!found) notFound();
  const deploys = await loadChanges(project, next);
  return (
    <AppShell context={context} project={project} view="changes">
      <ChangesView project={project} projectName={found.project.name} deploys={deploys} now={Date.now()} />
    </AppShell>
  );
}
