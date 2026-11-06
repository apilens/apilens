import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ChannelsSettings } from "@/components/alerts/channels";
import { AppShell } from "@/components/app-shell";
import { ApiKeysSettings } from "@/components/project-settings/api-keys";
import { CaptureSettings, type CaptureLoad } from "@/components/project-settings/capture";
import { HealthChecks, type HealthChecksLoad } from "@/components/project-settings/health-checks";
import { IngestHealth, type IngestLoad } from "@/components/project-settings/ingest-health";
import { PrivacySettings } from "@/components/project-settings/privacy";
import { CHANNELS_SECTION } from "@/lib/alerts";
import { getContext, getSession } from "@/lib/auth/server";
import { KEYS_PAGE, KEYS_SECTION } from "@/lib/api-keys";
import { CAPTURE_SECTION } from "@/lib/capture-policy";
import { PROJECT_SETTINGS } from "@/lib/data";
import { CHECKS_PAGE, EVENTS_SHOWN, HEALTH_CHECKS_SECTION } from "@/lib/health-checks";
import { type ApiKey, type AppIngestStats, type ManagedApp, type NamedApp, type NotificationChannel, type PrivacyPolicy, identity, isApiError } from "@/lib/identity";
import { INGEST_DAYS, INGEST_SECTION } from "@/lib/ingest-health";
import { type SearchParams, pageRedirect, parsePage, slicePage } from "@/lib/pagination";
import { PRIVACY_SECTION } from "@/lib/privacy-policy";
import { findProject } from "@/lib/scope";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";

export const metadata: Metadata = { title: PROJECT_SETTINGS.label };

const SECTIONS = ["", "environments", KEYS_SECTION, CAPTURE_SECTION, PRIVACY_SECTION, INGEST_SECTION, CHANNELS_SECTION, HEALTH_CHECKS_SECTION, "sdk", "retention", "integrations", "danger"];

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

/** `GET /projects/{slug}/apps` (every state), to name the apps keys are limited to and offer them; null when unreadable. */
async function loadManagedApps(project: string, next: string): Promise<ManagedApp[] | null> {
  const session = await getSession();
  try {
    return (await session.call((o) => identity().listManagedApps(project, o))).apps ?? [];
  } catch (err) {
    if (isSessionExpired(err)) redirectToRefresh(next);
    if (isApiError(err)) return null;
    throw err;
  }
}

/** `GET /projects/{slug}/alerts/channels` (#610), or null when the API could not answer. */
async function loadChannels(project: string, next: string): Promise<NotificationChannel[] | null> {
  const session = await getSession();
  try {
    return (await session.call((o) => identity().listChannels(project, o))).channels ?? [];
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

/**
 * The project's apps, the one `?app=` names (else the first), its ingest-edge counters over the
 * last days and its status (for the SDK counters). Each part is null when the API could not
 * answer; the counters are `off` when the install keeps none (503).
 */
async function loadIngest(project: string, appSlug: string | undefined, next: string): Promise<IngestLoad> {
  const session = await getSession();
  const attempt = async <T,>(fn: () => Promise<T>, off?: T): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      if (isSessionExpired(err)) redirectToRefresh(next);
      if (isApiError(err)) return off !== undefined && err.status === 503 ? off : null;
      throw err;
    }
  };
  const listed = await attempt(() => session.call((o) => identity().projectApps(project, o)));
  if (!listed) return { apps: null, app: null, stats: null, status: null };
  const apps: NamedApp[] = listed.apps ?? [];
  const app = apps.find((a) => a.slug === appSlug) ?? apps[0] ?? null;
  if (!app) return { apps, app: null, stats: null, status: null };
  const [stats, status] = await Promise.all([
    attempt<AppIngestStats | "off">(() => session.call((o) => identity().appIngestStats(project, app.id, INGEST_DAYS, o)), "off"),
    attempt(() => session.call((o) => identity().appHealthStatus(project, app.id, o))),
  ]);
  return { apps, app, stats, status };
}

/**
 * The project's apps and environments, its health checks and the latest failures of the checks on
 * the page `search` names (#608): the list is paged, so only those checks' events are fetched.
 * Each part is null when the API could not answer (the page says so).
 */
async function loadHealthChecks(project: string, search: SearchParams, next: string): Promise<HealthChecksLoad> {
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
  const [listed, checked] = await Promise.all([
    attempt(() => session.call((o) => identity().projectApps(project, o))),
    attempt(() => session.call((o) => identity().listHealthChecks(project, o))),
  ]);
  const checks = checked ? (checked.health_checks ?? []) : null;
  const events = Object.fromEntries(
    await Promise.all(
      slicePage(checks ?? [], parsePage(search, CHECKS_PAGE)).rows.map(async (c) => {
        const got = await attempt(() => session.call((o) => identity().healthCheckEvents(project, c.id, EVENTS_SHOWN, o)));
        return [c.id, got ? (got.events ?? []) : null] as const;
      }),
    ),
  );
  return { apps: listed ? (listed.apps ?? []) : null, environments: listed?.environments ?? [], checks, events };
}

// API keys (#350), capture (#598), privacy (#599), ingest health (#602), alert channels (#610) and health checks (#608) have content; the other sections come later.
export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ project: string; section?: string[] }>;
  searchParams: Promise<SearchParams>;
}) {
  const { project, section } = await params;
  if (section && (section.length > 1 || !SECTIONS.includes(section[0]))) notFound();
  const next = `/${project}/settings${section?.[0] ? `/${section[0]}` : ""}`;
  const context = await getContext(next);
  const found = findProject(context, project);
  if (!found) notFound();
  if (section?.[0] === KEYS_SECTION) {
    const query = await searchParams;
    const [keys, apps] = await Promise.all([loadApiKeys(project, next), loadManagedApps(project, next)]);
    // A page past the end (the list shrank, or a hand-edited URL) lands on the last page.
    const fix = keys ? pageRedirect(next, query, keys.length, KEYS_PAGE) : null;
    if (fix) redirect(fix);
    return (
      <AppShell context={context} project={project} view={PROJECT_SETTINGS.slug}>
        <ApiKeysSettings project={project} projectName={found.project.name} initial={keys} apps={apps} params={query} now={Date.now()} />
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
  if (section?.[0] === INGEST_SECTION) {
    const { app } = await searchParams;
    const load = await loadIngest(project, typeof app === "string" ? app : undefined, next);
    return (
      <AppShell context={context} project={project} view={PROJECT_SETTINGS.slug}>
        <IngestHealth project={project} projectName={found.project.name} load={load} />
      </AppShell>
    );
  }
  if (section?.[0] === CHANNELS_SECTION) {
    const channels = await loadChannels(project, next);
    return (
      <AppShell context={context} project={project} view={PROJECT_SETTINGS.slug}>
        <ChannelsSettings project={project} projectName={found.project.name} channels={channels} />
      </AppShell>
    );
  }
  if (section?.[0] === HEALTH_CHECKS_SECTION) {
    const search = await searchParams;
    const load = await loadHealthChecks(project, search, next);
    return (
      <AppShell context={context} project={project} view={PROJECT_SETTINGS.slug}>
        <HealthChecks project={project} projectName={found.project.name} load={load} search={search} />
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
