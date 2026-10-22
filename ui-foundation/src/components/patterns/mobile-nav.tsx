"use client";

import { usePathname } from "next/navigation";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { ListIcon } from "@/components/ui/icon";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { orgBySlug, projectBySlug } from "@/lib/demo-data";
import { ORG_NAV, PROJECT_NAV, type Scope } from "./nav-config";
import { ShortcutsDialog } from "./shortcuts-dialog";
import { SidebarBody } from "./sidebar";
import { TenantAvatar } from "./tenant-avatar";

/**
 * Below md: a menu button plus the current scope in the top bar, opening the
 * full sidebar as a sheet from the left. The same body as desktop, so nothing
 * is missing on a phone. It closes on navigation.
 */
export function MobileNav({ scope }: { scope: Scope }) {
  const [open, setOpen] = React.useState(false);
  const [switcherOpen, setSwitcherOpen] = React.useState(false);
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);
  const pathname = usePathname();
  const [lastPath, setLastPath] = React.useState(pathname);
  if (pathname !== lastPath) {
    // Route changed (e.g. via the switcher): close the sheet during render, no effect needed.
    setLastPath(pathname);
    setOpen(false);
  }

  const name = scope.kind === "project" ? projectBySlug(scope.slug).name : orgBySlug(scope.slug).name;
  const items = (scope.kind === "project" ? PROJECT_NAV : ORG_NAV).flatMap((g) => g.items);

  return (
    <div className="flex min-w-0 items-center gap-1 md:hidden">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Open navigation">
            <ListIcon />
          </Button>
        </SheetTrigger>
        <SheetContent aria-describedby={undefined}>
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SidebarBody
            scope={scope}
            switcherOpen={switcherOpen}
            onSwitcherOpenChange={setSwitcherOpen}
            onOpenShortcuts={() => setShortcutsOpen(true)}
            onNavigate={() => setOpen(false)}
          />
        </SheetContent>
      </Sheet>
      <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-foreground">
        <TenantAvatar name={name} slug={scope.slug} size="sm" />
        <span className="truncate">{name}</span>
      </span>
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} items={items} />
    </div>
  );
}
