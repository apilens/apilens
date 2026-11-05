import "server-only";

// Reads of the alerts pages (#610), as the signed-in user. Each answers null when the API could
// not answer (the page says so) and sends an expired session through the refresh.
import { getSession } from "@/lib/auth/server";
import { type AlertRule, type IdentityClient, type NamedApp, identity, isApiError } from "@/lib/identity";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";

type Authed = Parameters<IdentityClient["me"]>[0];

/** One read as the signed-in user; null when the API answered an error. */
export async function load<T>(next: string, fn: (api: IdentityClient, o: Authed) => Promise<T>): Promise<T | null> {
  const session = await getSession();
  try {
    return await session.call((o) => fn(identity(), o));
  } catch (err) {
    if (isSessionExpired(err)) redirectToRefresh(next);
    if (isApiError(err)) return null;
    throw err;
  }
}

/** The project's apps and recent environments (`GET /project`); empty when unknown. */
export async function loadApps(project: string, next: string): Promise<{ apps: NamedApp[]; environments: string[] }> {
  const res = await load(next, (api, o) => api.projectApps(project, o));
  return { apps: res?.apps ?? [], environments: res?.environments ?? [] };
}

/** App id → its name, for labels. */
export const appNames = (apps: NamedApp[]): Record<string, string> => Object.fromEntries(apps.map((a) => [a.id, a.name || a.slug]));

/** The rule, "gone" when the API answers 404 or 422 (deleted, another project's, not an id), null on any other error. */
export async function loadRule(project: string, id: string, next: string): Promise<AlertRule | "gone" | null> {
  const session = await getSession();
  try {
    return await session.call((o) => identity().getAlertRule(project, id, o));
  } catch (err) {
    if (isSessionExpired(err)) redirectToRefresh(next);
    if (isApiError(err)) return err.status === 404 || err.status === 422 ? "gone" : null;
    throw err;
  }
}
