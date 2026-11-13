// API keys still answer at `/settings/keys` but are not in the section nav: they move to
// Access › API keys, which redirects this path (#801).
import { redirect } from "next/navigation";
import { ApiKeysSettings } from "@/components/project-settings/api-keys";
import { getSession } from "@/lib/auth/server";
import { KEYS_PAGE } from "@/lib/api-keys";
import { type ApiKey, type ManagedApp, identity, isApiError } from "@/lib/identity";
import { pageRedirect } from "@/lib/pagination";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";
import type { SectionContext } from "./types";

type KeysLoad = { keys: ApiKey[] | null; apps: ManagedApp[] | null };

/**
 * `GET /projects/{slug}/api-keys` and `GET /projects/{slug}/apps` (every state, to name the apps
 * keys are limited to and offer them); each is null when the API could not answer.
 */
export async function load({ project, search, next }: SectionContext): Promise<KeysLoad> {
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
  const [keys, apps] = await Promise.all([
    attempt(async () => (await session.call((o) => identity().listApiKeys(project, o))) ?? []),
    attempt(async () => (await session.call((o) => identity().listManagedApps(project, o))).apps ?? []),
  ]);
  // A page past the end (the list shrank, or a hand-edited URL) lands on the last page.
  const fix = keys ? pageRedirect(next, search, keys.length, KEYS_PAGE) : null;
  if (fix) redirect(fix);
  return { keys, apps };
}

export function render({ keys, apps }: KeysLoad, { project, projectName, search }: SectionContext) {
  return <ApiKeysSettings project={project} projectName={projectName} initial={keys} apps={apps} params={search} now={Date.now()} />;
}
