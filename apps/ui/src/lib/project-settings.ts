// The project settings sections (`/<project>/settings/*`, #800): what the section nav lists, in
// order and grouped. Each section's content lives in `app/[project]/settings/sections/<slug>.tsx`
// and is looked up by slug; a section without a file shows "Nothing here yet". Pure; safe in
// Client Components.

import { type Action, type Capabilities, can } from "./capabilities";
import { PROJECT_SETTINGS } from "./data";

export const PROJECT_SETTINGS_GROUPS = ["Project", "Data", "Alerting", "More"] as const;
export type ProjectSettingsGroup = (typeof PROJECT_SETTINGS_GROUPS)[number];

export interface ProjectSection {
  /** URL segment under `/<project>/settings`; empty for General, which `/settings` itself opens. */
  slug: string;
  label: string;
  group: ProjectSettingsGroup;
  /** One line describing the section. */
  summary: string;
  /** The action that makes the section visible in the nav; absent means everyone who sees the project. */
  capability?: Action;
  /** Shown in the error colour (destructive actions). */
  danger?: boolean;
}

export const PROJECT_SECTIONS: readonly ProjectSection[] = [
  { slug: "", label: "General", group: "Project", summary: "The project's name, slug and description." },
  { slug: "environments", label: "Environments", group: "Project", summary: "The environments your SDKs report from." },
  { slug: "sdk", label: "SDK setup", group: "Project", summary: "Install and configure an SDK for this project." },
  { slug: "capture", label: "Capture", group: "Data", summary: "What each app's SDKs capture and send." },
  { slug: "privacy", label: "Privacy", group: "Data", summary: "Fields masked at the ingest edge before anything is stored." },
  { slug: "retention", label: "Retention", group: "Data", summary: "How long each signal is kept." },
  { slug: "ingest", label: "Ingest health", group: "Data", summary: "What reaches the ingest edge and what it rejects." },
  { slug: "usage", label: "Usage", group: "Data", summary: "Events this project has sent." },
  { slug: "alerts", label: "Alert channels", group: "Alerting", summary: "Where alert notifications go." },
  { slug: "health-checks", label: "Health checks", group: "Alerting", summary: "Scheduled checks against your endpoints." },
  { slug: "integrations", label: "Integrations", group: "More", summary: "Tools connected to this project." },
  { slug: "danger", label: "Danger zone", group: "More", summary: "Pause, rename or delete the project.", capability: "project.delete", danger: true },
];

/** The section a `/<project>/settings/[[...section]]` route points at; undefined means 404. */
export function projectSection(section: string[] | undefined): ProjectSection | undefined {
  if (!section || section.length === 0) return PROJECT_SECTIONS[0];
  if (section.length > 1 || section[0] === "") return undefined;
  return PROJECT_SECTIONS.find((s) => s.slug === section[0]);
}

/** `/<project>/settings` or `/<project>/settings/<slug>`. */
export function projectSectionHref(project: string, s: Pick<ProjectSection, "slug">): string {
  return s.slug ? `/${project}/settings/${s.slug}` : `/${project}/settings`;
}

/**
 * The sections the nav shows on `project`: those without a capability, those whose capability is
 * allowed, and always `current` (a deep link keeps its place in the nav).
 */
export function visibleProjectSections(capabilities: Capabilities | null | undefined, project: string, current?: string): ProjectSection[] {
  return PROJECT_SECTIONS.filter((s) => s.slug === current || !s.capability || can(capabilities, project, s.capability));
}

/** The page title: `<Section> · Project settings`. */
export function projectSectionTitle(s: Pick<ProjectSection, "label">): string {
  return `${s.label} · ${PROJECT_SETTINGS.label}`;
}
