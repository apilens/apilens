import "server-only";

// What the rule editor (#610) needs besides the rule: the project's apps and environments, its
// channels and the consumer groups the SDK reported lately (`GET /consumer-groups`, the Consumers
// page's groups view), which the group field suggests. Channels and groups are null when they
// could not be loaded.
import type { NamedApp, NotificationChannel } from "@/lib/identity";
import { load, loadApps } from "../load";

/** How many of the groups seen, busiest first, the group field suggests. */
const GROUP_SUGGESTIONS = 500;

export interface EditorData {
  apps: NamedApp[];
  environments: string[];
  channels: NotificationChannel[] | null;
  /** SDK consumer group names seen in the last 7 days, sorted. */
  groups: string[] | null;
}

export async function loadEditorData(project: string, contextEnvironments: string[], next: string): Promise<EditorData> {
  const [{ apps, environments }, channels, groups] = await Promise.all([
    loadApps(project, next),
    load(next, (api, o) => api.listChannels(project, o)),
    load(next, (api, o) => api.listConsumerGroupTraffic(project, { range: "7d", sort: "requests", limit: GROUP_SUGGESTIONS }, o)),
  ]);
  return {
    apps,
    environments: [...new Set([...environments, ...contextEnvironments])].sort(),
    channels: channels ? (channels.channels ?? []) : null,
    groups: groups ? (groups.groups ?? []).map((g) => g.group).sort((a, b) => a.localeCompare(b)) : null,
  };
}
