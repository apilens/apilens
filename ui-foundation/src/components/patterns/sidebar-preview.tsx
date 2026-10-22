"use client";

import * as React from "react";

import type { Scope } from "./nav-config";
import { SidebarBody } from "./sidebar";

/** Static, interactive sidebar specimens for /design (expanded + collapsed). */
export function SidebarPreview({ scope, active, collapsed = false }: { scope: Scope; active: string; collapsed?: boolean }) {
  const [switcherOpen, setSwitcherOpen] = React.useState(false);
  return (
    <div className="flex h-128 overflow-hidden rounded-lg border border-border bg-background">
      <div data-collapsed={collapsed} className={collapsed ? "flex w-12 flex-col border-r border-border bg-sidebar" : "flex w-60 flex-col border-r border-border bg-sidebar"}>
        <SidebarBody
          scope={scope}
          collapsed={collapsed}
          switcherOpen={switcherOpen}
          onSwitcherOpenChange={setSwitcherOpen}
          onToggle={() => {}}
          onOpenShortcuts={() => {}}
          activeOverride={active}
        />
      </div>
      <div className="flex-1" />
    </div>
  );
}
