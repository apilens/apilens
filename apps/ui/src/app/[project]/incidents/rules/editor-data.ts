import "server-only";

// What the rule editor (#610) needs besides the rule: the project's apps and environments, its
// channels and its consumer groups. Channels and groups are null when they could not be loaded.
import type { ConsumerGroup, NamedApp, NotificationChannel } from "@/lib/identity";
import { load, loadApps } from "../load";

export interface EditorData {
  apps: NamedApp[];
  environments: string[];
  channels: NotificationChannel[] | null;
  groups: ConsumerGroup[] | null;
}

export async function loadEditorData(project: string, contextEnvironments: string[], next: string): Promise<EditorData> {
  const [{ apps, environments }, channels, groups] = await Promise.all([
    loadApps(project, next),
    load(next, (api, o) => api.listChannels(project, o)),
    load(next, (api, o) => api.listConsumerGroups(project, o)),
  ]);
  return {
    apps,
    environments: [...new Set([...environments, ...contextEnvironments])].sort(),
    channels: channels ? (channels.channels ?? []) : null,
    groups: groups ? (groups.groups ?? []) : null,
  };
}
