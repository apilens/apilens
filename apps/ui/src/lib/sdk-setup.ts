// Project settings → SDK setup (#817): the install steps onboarding showed (#333), found again.
// The snippets come from `snippetsFor` in lib/install.ts and the languages from lib/instrument.ts,
// so this page and onboarding render the same source. Pure; safe in Client Components.
import { runtimeLine } from "./capture-policy";
import type { AppEnvironmentReport, IngestStatus, NamedApp } from "./identity";
import { DEFAULT_POSTURE, type Snippet, appIdFor, snippetsFor } from "./install";
import { LANGUAGES, type Language } from "./instrument";

/** The languages with an APILens SDK, in onboarding's order: one tab each. */
export const SDK_LANGUAGES: readonly Language[] = LANGUAGES.filter((l) => Boolean(l.sdk));

/** The docs setup guide each SDK's snippet follows (apps/docs/setup-guides). */
const SDK_GUIDES: Readonly<Record<string, { path: string; framework: string }>> = {
  python: { path: "setup-guides/fastapi", framework: "FastAPI" },
  node: { path: "setup-guides/express", framework: "Express" },
  java: { path: "setup-guides/spring-mvc", framework: "Spring MVC" },
};

/** The docs page for `language`'s SDK, or undefined for a language without one. */
export function sdkDocs(docs: string, language: string): { href: string; framework: string } | undefined {
  const guide = SDK_GUIDES[language];
  if (!guide) return undefined;
  return { href: `${docs.replace(/\/+$/, "")}/${guide.path}`, framework: guide.framework };
}

/**
 * The snippets for `language`'s SDK: the same ones onboarding shows, with the key placeholder
 * (a stored key is never shown) and the documented first-rollout capture posture.
 */
export function setupSnippets(language: string, project: string, ingestUrl: string): Snippet[] {
  return snippetsFor({ language, method: "sdk", appId: appIdFor(project), ingestUrl, posture: DEFAULT_POSTURE });
}

/** One app's status: what its SDKs reported per environment; null when it could not be loaded. */
export interface AppSetupStatus {
  app: NamedApp;
  reports: AppEnvironmentReport[] | null;
}

/** The SDK an environment last reported: `FastAPI 0.115 · Python 3.13 · SDK 0.4.0`, or a fallback. */
export function reportedSdk(r: Pick<AppEnvironmentReport, "framework" | "framework_version" | "runtime_version" | "sdk_version">): string {
  return runtimeLine(r) || "Unknown SDK";
}

/** The line for the project's last data: when it last arrived, or that none has. */
export function lastDataLine(status: IngestStatus | null, ago: (at: string) => string): string {
  if (!status) return "Couldn’t check when data last arrived. Reload the page to try again.";
  if (!status.received || !status.last_at) return "No data received yet.";
  return `Last data received ${ago(status.last_at)}.`;
}
