import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ApiKeysSettings } from "@/components/project-settings/api-keys";
import { getContext, getSession } from "@/lib/auth/server";
import { KEYS_SECTION } from "@/lib/api-keys";
import { PROJECT_SETTINGS } from "@/lib/data";
import { type ApiKey, identity, isApiError } from "@/lib/identity";
import { findProject } from "@/lib/scope";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";

export const metadata: Metadata = { title: PROJECT_SETTINGS.label };

const SECTIONS = ["", "environments", KEYS_SECTION, "sdk", "retention", "integrations", "danger"];

/** `GET /projects/{slug}/api-keys`, or null when the API could not answer (the card says so). */
async function loadApiKeys(project: string, next: string): Promise<ApiKey[] | null> {
  const session = await getSession();
  try {
    return (await session.call((o) => identity().listApiKeys(project, o))) ?? [];
  } catch (err) {
    if (isSessionExpired(err)) redirectToRefresh(next);
    if (isApiError(err)) return null;
    throw err;
  }
}

// API keys (#350) have content; the other sections come later.
export default async function SettingsPage({ params }: { params: Promise<{ project: string; section?: string[] }> }) {
  const { project, section } = await params;
  if (section && (section.length > 1 || !SECTIONS.includes(section[0]))) notFound();
  const next = `/${project}/settings${section?.[0] ? `/${section[0]}` : ""}`;
  const context = await getContext(next);
  const found = findProject(context, project);
  if (!found) notFound();
  if (section?.[0] === KEYS_SECTION) {
    const keys = await loadApiKeys(project, next);
    return (
      <AppShell context={context} project={project} view={PROJECT_SETTINGS.slug}>
        <ApiKeysSettings project={project} projectName={found.project.name} initial={keys} now={Date.now()} />
      </AppShell>
    );
  }
  return <AppShell context={context} project={project} view={PROJECT_SETTINGS.slug} />;
}
