"use client";

import * as React from "react";

import { Tooltip } from "@/components/ui/tooltip";
import { useCan, type Action } from "@/lib/permissions";

/**
 * Permission-aware control.
 *  - mode="disable" (default): the control stays visible but disabled, with
 *    a tooltip saying who can do it. Use for actions users should know exist.
 *  - mode="hide": render nothing. Use only for admin-only surfaces whose
 *    existence is noise to everyone else.
 *
 *   <Gated action="api_keys.revoke"><Button variant="ghost">Revoke</Button></Gated>
 */
export function Gated({
  action,
  mode = "disable",
  children,
}: {
  action: Action;
  mode?: "disable" | "hide";
  children: React.ReactElement<{ disabled?: boolean }>;
}) {
  const { allowed, reason } = useCan(action);
  if (allowed) return children;
  if (mode === "hide") return null;
  // Disabled buttons swallow pointer events, so the tooltip anchors on a wrapper.
  return (
    <Tooltip content={reason}>
      <span tabIndex={0} className="focus-ring inline-flex rounded-md">
        {React.cloneElement(children, { disabled: true })}
      </span>
    </Tooltip>
  );
}
