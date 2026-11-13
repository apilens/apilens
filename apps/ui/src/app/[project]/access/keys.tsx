// Access › API keys (`/<project>/access/keys`, #801, #810): moved here from project settings,
// whose `/settings/keys` now redirects to this tab. `?state=` and `?inactive=1` filter the list.
import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { ApiKeysSettings } from "@/components/project-settings/api-keys";
import { getSession } from "@/lib/auth/server";
import { KEYS_PAGE, filterKeys, parseKeyFilter, pickableEnvironments } from "@/lib/api-keys";
import { type ApiKey, type ManagedApp, identity, isApiError } from "@/lib/identity";
import { pageRedirect } from "@/lib/pagination";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";
import type { SectionContext } from "../settings/sections/types";

type KeysLoad = { keys: ApiKey[] | null; apps: ManagedApp[] | null; environments: string[] | null };

/**
 * `GET /projects/{slug}/api-keys`, `GET /projects/{slug}/apps` (every state, to name the apps
 * keys are limited to and offer them) and `GET /projects/{slug}/environments` (the visible ones a
 * new key can be pinned to, #811); each is null when the API could not answer, and without
 * environments the create dialog leaves the environment field out.
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
  const [keys, apps, environments] = await Promise.all([
    attempt(async () => (await session.call((o) => identity().listApiKeys(project, o))) ?? []),
    attempt(async () => (await session.call((o) => identity().listManagedApps(project, o))).apps ?? []),
    attempt(async () => pickableEnvironments((await session.call((o) => identity().listEnvironments(project, o))).environments ?? [])),
  ]);
  // A page past the end (the list shrank, or a hand-edited URL) lands on the last page.
  const fix = keys ? pageRedirect(next, search, filterKeys(keys, parseKeyFilter(search)).length, KEYS_PAGE) : null;
  if (fix) redirect(fix);
  return { keys, apps, environments };
}

export function render({ keys, apps, environments }: KeysLoad, { project, projectName, search }: SectionContext, nav: ReactNode) {
  return <ApiKeysSettings project={project} projectName={projectName} initial={keys} apps={apps} environments={environments} params={search} now={Date.now()} nav={nav} />;
}
