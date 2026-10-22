"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

import { REQUIRED_ROLE, type Action, type Role } from "./capabilities";

export type { Action, Role } from "./capabilities";

interface Capabilities {
  role: Role;
  actions: ReadonlySet<Action>;
}

const CapabilitiesContext = createContext<Capabilities | null>(null);

/**
 * Server components pass plain data (role + action list) across the RSC
 * boundary; the Set is built here on the client.
 */
export function CapabilitiesProvider({ role, actions, children }: { role: Role; actions: Action[]; children: ReactNode }) {
  const value = useMemo<Capabilities>(() => ({ role, actions: new Set(actions) }), [role, actions]);
  return <CapabilitiesContext.Provider value={value}>{children}</CapabilitiesContext.Provider>;
}

export interface Decision {
  allowed: boolean;
  /** Sentence-case reason for the disabled state, or null when allowed. */
  reason: string | null;
}

export function useCan(action: Action): Decision {
  return useMaybeCan(action);
}

/** For components where gating is optional (Field's `editableBy`): no action → allowed. */
export function useMaybeCan(action: Action | undefined): Decision {
  const caps = useContext(CapabilitiesContext);
  if (!action) return { allowed: true, reason: null };
  if (!caps) throw new Error("Permission checks must render inside <CapabilitiesProvider>");
  if (caps.actions.has(action)) return { allowed: true, reason: null };
  const owner = REQUIRED_ROLE[action] === "owner";
  return {
    allowed: false,
    reason: `Only ${owner ? "project owners" : "admins"} can do this. Ask ${owner ? "an owner" : "an admin"} for access.`,
  };
}
