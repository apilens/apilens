import { ChannelsSettings } from "@/components/alerts/channels";
import { getSession } from "@/lib/auth/server";
import { type NotificationChannel, identity, isApiError } from "@/lib/identity";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";
import type { SectionContext } from "./types";

/** `GET /projects/{slug}/alerts/channels` (#610), or null when the API could not answer. */
export async function load({ project, next }: SectionContext): Promise<NotificationChannel[] | null> {
  const session = await getSession();
  try {
    return (await session.call((o) => identity().listChannels(project, o))).channels ?? [];
  } catch (err) {
    if (isSessionExpired(err)) redirectToRefresh(next);
    if (isApiError(err)) return null;
    throw err;
  }
}

export function render(channels: NotificationChannel[] | null, { project, projectName }: SectionContext) {
  return <ChannelsSettings project={project} projectName={projectName} channels={channels} />;
}
