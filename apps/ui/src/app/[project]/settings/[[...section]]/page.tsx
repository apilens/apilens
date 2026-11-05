import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ApiKeysSettings } from "@/components/project-settings/api-keys";
import { CaptureSettings, type CaptureLoad } from "@/components/project-settings/capture";
import { PrivacySettings } from "@/components/project-settings/privacy";
import { getContext, getSession } from "@/lib/auth/server";
import { KEYS_SECTION } from "@/lib/api-keys";
import { CAPTURE_SECTION } from "@/lib/capture-policy";
import { PROJECT_SETTINGS } from "@/lib/data";
import { type ApiKey, type NamedApp, type PrivacyPolicy, identity, isApiError } from "@/lib/identity";
import { PRIVACY_SECTION } from "@/lib/privacy-policy";
import { findProject } from "@/lib/scope";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";

export const metadata: Metadata = { title: PROJECT_SETTINGS.label };

const SECTIONS = ["", "environments", KEYS_SECTION, CAPTURE_SECTION, PRIVACY_SECTION, "sdk", "retention", "integrations", "danger"];

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

/** `GET /projects/{slug}/privacy-policy` (project-wide), or null when the API could not answer. */
async function loadPrivacy(project: string, next: string): Promise<PrivacyPolicy | null> {
  const session = await getSession();
  try {
    return await session.call((o) => identity().getPrivacyPolicy(project, o));
  } catch (err) {
    if (isSessionExpired(err)) redirectToRefresh(next);
    if (isApiError(err)) return null;
    throw err;
  }
}

/**
 * The project's apps (`GET /project`), the one `?app=` names (else the first), its capture policy
 * and what its SDKs reported. Each part is null when the API could not answer (the page says so).
 */
async function loadCapture(project: string, appSlug: string | undefined, next: string): Promise<CaptureLoad> {
  const session = await getSession();
  const attempt = async <T,>(fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      if (isSessionExpired(err)) redirectToRefresh(next);
      if (isApiError(err)) return null;
      throw err;
    }
  };
  const listed = await attempt(() => session.call((o) => identity().projectApps(project, o)));
  if (!listed) return { apps: null, app: null, policy: null, reports: null };
  const apps: NamedApp[] = listed.apps ?? [];
  const app = apps.find((a) => a.slug === appSlug) ?? apps[0] ?? null;
  if (!app) return { apps, app: null, policy: null, reports: null };
  const [policy, reports] = await Promise.all([
    attempt(() => session.call((o) => identity().getCapturePolicy(app.id, o))),
    attempt(() => session.call((o) => identity().appReports(app.id, o))),
  ]);
  return { apps, app, policy, reports: reports ? (reports.environments ?? []) : null };
}

// API keys (#350), capture (#598) and privacy (#599) have content; the other sections come later.
export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ project: string; section?: string[] }>;
  searchParams: Promise<{ app?: string | string[] }>;
}) {
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
  if (section?.[0] === CAPTURE_SECTION) {
    const { app } = await searchParams;
    const load = await loadCapture(project, typeof app === "string" ? app : undefined, next);
    return (
      <AppShell context={context} project={project} view={PROJECT_SETTINGS.slug}>
        <CaptureSettings key={load.app?.id ?? "none"} project={project} projectName={found.project.name} userId={context.user.id} load={load} />
      </AppShell>
    );
  }
  if (section?.[0] === PRIVACY_SECTION) {
    const policy = await loadPrivacy(project, next);
    return (
      <AppShell context={context} project={project} view={PROJECT_SETTINGS.slug}>
        <PrivacySettings project={project} projectName={found.project.name} policy={policy} />
      </AppShell>
    );
  }
  return <AppShell context={context} project={project} view={PROJECT_SETTINGS.slug} />;
}
