import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getContext, getSession } from "@/lib/auth/server";
import { identity, isApiError } from "@/lib/identity";
import { findProject } from "@/lib/scope";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";

const TABS = ["", "instrumentation", "configuration", "deploys"];

export async function generateMetadata({ params }: { params: Promise<{ app: string }> }): Promise<Metadata> {
  const { app } = await params;
  return { title: app };
}

/** Whether `app` is an app of the project; null when the API could not say. */
async function hasApp(project: string, app: string, next: string): Promise<boolean | null> {
  const session = await getSession();
  try {
    const listed = await session.call((o) => identity().projectApps(project, o));
    return (listed.apps ?? []).some((a) => a.slug === app);
  } catch (err) {
    if (isSessionExpired(err)) redirectToRefresh(next);
    if (isApiError(err)) return null;
    throw err;
  }
}

// One app (service), opened from the Apps overview (#591). Content comes later.
export default async function AppPage({ params }: { params: Promise<{ project: string; app: string; tab?: string[] }> }) {
  const { project, app, tab } = await params;
  if (tab && (tab.length > 1 || !TABS.includes(tab[0]))) notFound();
  const next = `/${project}/apps/${app}${tab?.[0] ? `/${tab[0]}` : ""}`;
  const context = await getContext(next);
  if (!findProject(context, project)) notFound();
  if ((await hasApp(project, app, next)) === false) notFound();
  return <AppShell context={context} project={project} view="apps" />;
}
