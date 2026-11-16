import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { SetupReminder } from "@/components/onboarding/setup-reminder";
import { getContext } from "@/lib/auth/server";
import { VIEWS } from "@/lib/data";
import { LATER_PARAM, LATER_VALUE } from "@/lib/install";
import { findProject } from "@/lib/scope";

type Params = { project: string; view: string };
type SearchParams = Record<string, string | string[] | undefined>;

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { view } = await params;
  return { title: VIEWS.find((v) => v.slug === view)?.label ?? "APILens" };
}

/** Views with their own route under `app/[project]/` that this catch-all never serves. */
const OWN_ROUTE: ReadonlySet<string> = new Set(["access"]);

// The shell (sidebar, top bar, scope switcher) is built; page content is intentionally empty for now.
export default async function Page({ params, searchParams }: { params: Promise<Params>; searchParams: Promise<SearchParams> }) {
  const { project, view } = await params;
  if (OWN_ROUTE.has(view) || !VIEWS.some((v) => v.slug === view)) notFound();
  const context = await getContext(`/${project}/${view}`);
  if (!findProject(context, project)) notFound();
  // "I'll do this later" on the onboarding install step (#333) opens the project with a reminder.
  const later = (await searchParams)[LATER_PARAM] === LATER_VALUE;
  return (
    <AppShell context={context} project={project} view={view}>
      <div className="page">{later ? <SetupReminder project={project} /> : null}</div>
    </AppShell>
  );
}
