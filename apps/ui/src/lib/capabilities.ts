// Capabilities vocabulary: the actions `GET /api/v1/users/me/context` returns per project slug
// (`capabilities`). The UI gates buttons on these and never derives permissions from a role; the
// server still checks every request.
//
// Mirrors the table in docs/architecture/identity.md and `usercontext.Vocabulary`
// (internal/controlplane/usercontext). Actions are stable once shipped; add new ones in all three
// places and in authz/schema.zed in the same change.

/** Every action, in the order the server lists them. */
export const ACTIONS = [
  /** `project#view`: see the project and its telemetry. */
  "project.read",
  /** `project#edit`: project settings, environments. */
  "project.update",
  /** `project#delete`: the project's danger zone. */
  "project.delete",
  /** `project#manage_keys`: create ingest and read keys. */
  "api_keys.create",
  /** `project#manage_keys`: revoke keys. */
  "api_keys.revoke",
  /** `project#manage_capture`: edit an app's remote capture policy. */
  "capture.manage",
  /** `project#manage_alerts`: alert rules, notification channels and test notifications. */
  "alerts.manage",
  /** `organization#invite`: the invite dialog and Invitations page. */
  "members.invite",
  /** `organization#manage_members`: role changes and removal on Members. */
  "members.remove",
  /** `organization#manage_billing`: billing (SaaS). */
  "billing.manage",
] as const;

export type Action = (typeof ACTIONS)[number];

/** The `capabilities` member of the user context: allowed actions keyed by project slug. */
export type Capabilities = Record<string, readonly string[]>;

const KNOWN: ReadonlySet<string> = new Set(ACTIONS);

/** Whether `value` is an action of this vocabulary (a newer server may send unknown ones). */
export function isAction(value: string): value is Action {
  return KNOWN.has(value);
}

/**
 * Whether the user may perform `action` on project `slug`. A project missing from `capabilities`
 * allows nothing (fail closed).
 */
export function can(capabilities: Capabilities | null | undefined, slug: string, action: Action): boolean {
  if (!capabilities || !Object.hasOwn(capabilities, slug)) return false;
  return capabilities[slug]?.includes(action) ?? false;
}

/** The known actions allowed on project `slug`, in vocabulary order. */
export function actionsFor(capabilities: Capabilities | null | undefined, slug: string): Action[] {
  return ACTIONS.filter((action) => can(capabilities, slug, action));
}
