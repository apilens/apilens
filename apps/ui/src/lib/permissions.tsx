"use client";

// Permission gating for Client Components, fed from `capabilities` in `GET /users/me/context`
// (SpiceDB, #294). `AppShell` mounts `CapabilitiesProvider` with the current project's actions;
// `useCan` and `<Gated>` read it. Nothing here derives a permission from a role, and nothing here
// is a security boundary: the server checks every request with `authz.Require`.

import { createContext, useContext, useId, useMemo, type ReactNode } from "react";
import { type Action, type Capabilities, actionsFor } from "./capabilities";

export type { Action, Capabilities } from "./capabilities";

/** The reason a gated control shows when the user may not use it. */
export const DENIED_REASON = "Only admins can do this. Ask an admin for access.";

const CapabilitiesContext = createContext<ReadonlySet<Action> | null>(null);

/**
 * Makes the actions allowed on `project` available to `useCan` and `<Gated>`. `capabilities` is
 * the context's map keyed by project slug, passed as plain data across the RSC boundary. Without a
 * project, or for a project missing from the map, everything is denied (fail closed).
 * Organization actions (`members.*`, `billing.manage`) are the same on every project of an
 * organization, so the organization scope passes the organization's first project.
 */
export function CapabilitiesProvider({ capabilities, project, children }: { capabilities: Capabilities | null | undefined; project: string | undefined; children?: ReactNode }) {
  const value = useMemo<ReadonlySet<Action>>(() => new Set(project ? actionsFor(capabilities, project) : []), [capabilities, project]);
  return <CapabilitiesContext.Provider value={value}>{children}</CapabilitiesContext.Provider>;
}

export interface Decision {
  allowed: boolean;
  /** Why the control is disabled, or null when allowed. */
  reason: string | null;
}

/** Whether the user may perform `action` in the current scope. Must render inside `CapabilitiesProvider`. */
export function useCan(action: Action): Decision {
  const actions = useContext(CapabilitiesContext);
  if (!actions) throw new Error("useCan must render inside <CapabilitiesProvider>");
  return actions.has(action) ? { allowed: true, reason: null } : { allowed: false, reason: DENIED_REASON };
}

/**
 * Renders `children` as they are when `action` is allowed. When it is not: `hide` renders nothing;
 * otherwise every form control inside is disabled and the wrapper shows the reason on hover and to
 * screen readers. A function child receives the decision and renders whatever it needs.
 */
export function Gated({ action, hide = false, children }: { action: Action; hide?: boolean; children: ReactNode | ((decision: Decision) => ReactNode) }) {
  const decision = useCan(action);
  const reasonId = useId();
  if (typeof children === "function") return <>{children(decision)}</>;
  if (decision.allowed) return <>{children}</>;
  if (hide) return null;
  return (
    <span className="gated" title={decision.reason ?? undefined} data-gated={action}>
      <fieldset disabled aria-describedby={reasonId}>
        {children}
      </fieldset>
      <span id={reasonId} className="gated-reason">
        {decision.reason}
      </span>
    </span>
  );
}
