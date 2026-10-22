import { Suspense } from "react";

import { Breadcrumb, MobileNav, NavLinks, ThemeToggle } from "@/components/client";
import { StatusDot } from "@/components/badge";
import { api, getMeta, settle } from "@/lib/api";

// Read the API URL and key per request, never at build time.
export const dynamic = "force-dynamic";

/**
 * App frame (Aperture): 240px sidebar, 48px top bar, content max 1280px,
 * left-aligned. Desktop is a fixed frame where only content scrolls; mobile
 * falls back to page scroll with the nav in a disclosure.
 */
export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const [project, meta] = await Promise.all([settle(api.project()), getMeta()]);
  const name = project.ok ? project.data.project.name : "APILens";

  return (
    <div className="flex min-h-dvh bg-background md:h-dvh md:min-h-0">
      <aside aria-label="Sidebar" className="hidden w-60 shrink-0 flex-col border-r border-border bg-sidebar md:flex">
        <div className="flex h-12 shrink-0 items-center px-4">
          <span className="text-sm font-semibold tracking-tight text-foreground">APILens</span>
        </div>

        <div className="mx-2 mb-3 rounded-md px-2 py-2">
          {project.ok ? (
            <>
              <p className="truncate text-sm font-medium text-foreground">{project.data.project.name}</p>
              <p className="truncate font-mono text-2xs text-subtle-foreground">
                {project.data.org.slug}/{project.data.project.slug}
              </p>
            </>
          ) : (
            <>
              <p className="truncate text-sm font-medium text-foreground">No project</p>
              <p className="truncate text-xs text-subtle-foreground">Console is not connected</p>
            </>
          )}
        </div>

        <nav aria-label="Project" className="min-h-0 flex-1 overflow-y-auto px-2">
          <Suspense>
            <NavLinks />
          </Suspense>
        </nav>

        <div className="shrink-0 border-t border-border px-4 py-3 text-xs text-subtle-foreground">
          {meta ? (
            <StatusDot tone="success" label={<span className="text-muted-foreground">Backend {meta.version}</span>} />
          ) : (
            <StatusDot tone="danger" label={<span className="text-muted-foreground">Backend unreachable</span>} />
          )}
          <p className="mt-1">Times are shown in UTC</p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex h-12 shrink-0 items-center gap-3 border-b border-border bg-background px-4 md:px-6">
          <Suspense>
            <MobileNav project={name} />
            <div className="hidden min-w-0 md:block">
              <Breadcrumb project={name} />
            </div>
          </Suspense>
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
          </div>
        </header>
        <main className="flex-1 md:overflow-y-auto">
          <div className="mx-auto w-full max-w-7xl px-4 py-6 md:px-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
