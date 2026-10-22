import * as React from "react";

import { MagnifyingGlassIcon } from "@/components/ui/icon";
import { Kbd } from "@/components/ui/kbd";
import { MobileNav } from "./mobile-nav";
import type { Scope } from "./nav-config";
import { AppSidebar } from "./sidebar";
import { ThemeToggle } from "./theme-toggle";

/**
 * The frame every scoped page renders inside (project or organization):
 *  - one system banner slot above everything
 *  - sidebar: scope switcher, grouped nav, usage, account
 *  - top bar (48px): search and theme; page actions live in PageHeader
 *  - content: max 1280px, left-aligned
 *
 * Desktop is a fixed frame: sidebar and top bar never scroll away; only the
 * content scrolls. Mobile falls back to normal page scroll with a sticky top bar.
 */
export function AppShell({
  scope,
  defaultCollapsed,
  banner,
  children,
}: {
  scope: Scope;
  defaultCollapsed?: boolean;
  banner?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col bg-background md:h-dvh md:min-h-0">
      {banner}
      <div className="flex min-h-0 flex-1">
        <AppSidebar scope={scope} defaultCollapsed={defaultCollapsed} />
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-40 flex h-12 shrink-0 items-center gap-3 border-b border-border bg-background px-2 md:px-6">
            <MobileNav scope={scope} />
            <div className="hidden h-8 w-full max-w-sm items-center gap-2 rounded-md bg-card px-2.5 text-sm text-subtle-foreground shadow-control sm:flex">
              <MagnifyingGlassIcon className="size-4" />
              <span className="flex-1 truncate">Search endpoints, consumers, traces</span>
              <Kbd>⌘K</Kbd>
            </div>
            <div className="ml-auto flex items-center gap-1">
              <ThemeToggle />
            </div>
          </header>
          <main className="flex-1 md:overflow-y-auto">
            <div className="mx-auto w-full max-w-7xl px-4 py-6 md:px-6">{children}</div>
          </main>
        </div>
      </div>
    </div>
  );
}
