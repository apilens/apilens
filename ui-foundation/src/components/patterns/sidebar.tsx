"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { SidebarSimpleIcon } from "@/components/ui/icon";
import { Meter } from "@/components/ui/meter";
import { Tooltip } from "@/components/ui/tooltip";
import { NAV_COUNTS, USAGE } from "@/lib/demo-data";
import { formatCount } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ORG_NAV, PROJECT_NAV, SIDEBAR_COOKIE, activeHref, scopeBase, type NavItem, type Scope } from "./nav-config";
import { ScopeSwitcher, ShortcutLabel } from "./scope-switcher";
import { ShortcutsDialog } from "./shortcuts-dialog";
import { useNavShortcuts } from "./use-nav-shortcuts";
import { UserMenu } from "./user-menu";

/**
 * Desktop sidebar. 240px expanded, 48px icon rail collapsed (`[` or the
 * header button). The state lives in a cookie the server reads, so the first
 * paint is already right. Collapse is instant on purpose: width is layout, and
 * layout never animates here.
 */
export function AppSidebar({ scope, defaultCollapsed = false }: { scope: Scope; defaultCollapsed?: boolean }) {
  const [collapsed, setCollapsed] = React.useState(defaultCollapsed);
  const [switcherOpen, setSwitcherOpen] = React.useState(false);
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false);

  const groups = scope.kind === "project" ? PROJECT_NAV : ORG_NAV;
  const items = React.useMemo(() => groups.flatMap((g) => g.items), [groups]);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    document.cookie = `${SIDEBAR_COOKIE}=${next ? "collapsed" : "expanded"}; path=/; max-age=31536000; samesite=lax`;
  };

  useNavShortcuts({
    base: scopeBase(scope),
    items,
    onToggleSidebar: toggle,
    onOpenSwitcher: () => setSwitcherOpen(true),
    onOpenHelp: () => setShortcutsOpen(true),
  });

  return (
    <aside
      aria-label="Sidebar"
      data-collapsed={collapsed}
      className={cn("hidden shrink-0 flex-col border-r border-border bg-sidebar md:flex", collapsed ? "w-12" : "w-60")}
    >
      <SidebarBody
        scope={scope}
        collapsed={collapsed}
        switcherOpen={switcherOpen}
        onSwitcherOpenChange={setSwitcherOpen}
        onToggle={toggle}
        onOpenShortcuts={() => setShortcutsOpen(true)}
      />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} items={items} />
    </aside>
  );
}

/** Everything inside the sidebar; shared by the desktop aside, the mobile sheet and /design. */
export function SidebarBody({
  scope,
  collapsed = false,
  switcherOpen,
  onSwitcherOpenChange,
  onToggle,
  onOpenShortcuts,
  onNavigate,
  activeOverride,
}: {
  scope: Scope;
  collapsed?: boolean;
  switcherOpen: boolean;
  onSwitcherOpenChange: (open: boolean) => void;
  onToggle?: () => void;
  onOpenShortcuts: () => void;
  onNavigate?: () => void;
  /** For previews outside a real route. */
  activeOverride?: string;
}) {
  const pathname = usePathname();
  const groups = scope.kind === "project" ? PROJECT_NAV : ORG_NAV;
  const base = scopeBase(scope);
  const active = activeOverride ?? activeHref(groups.flatMap((g) => g.items), base, pathname);
  const counts = scope.kind === "project" ? (NAV_COUNTS[scope.slug] ?? {}) : {};
  const orgSlug = scope.kind === "project" ? scope.orgSlug : scope.slug;

  return (
    <>
      <div className={cn("flex h-12 shrink-0 items-center gap-1 px-2", collapsed && "justify-center")}>
        <ScopeSwitcher
          scope={scope}
          collapsed={collapsed}
          open={switcherOpen}
          onOpenChange={onSwitcherOpenChange}
          onNavigate={onNavigate}
        />
        {onToggle && !collapsed ? (
          <Tooltip content={<ShortcutLabel label="Collapse sidebar" keys={["["]} />}>
            <Button variant="ghost" size="icon-sm" aria-label="Collapse sidebar" onClick={onToggle}>
              <SidebarSimpleIcon />
            </Button>
          </Tooltip>
        ) : null}
      </div>

      <nav aria-label={scope.kind === "project" ? "Project" : "Organization"} className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {groups.map((group, i) => (
          <div key={group.label ?? "home"} className={cn(i > 0 && (collapsed ? "mt-2 border-t border-border pt-2" : "mt-5"))}>
            {group.label && !collapsed ? <h2 className="mb-1 px-2 text-xs font-medium text-subtle-foreground">{group.label}</h2> : null}
            <ul className="flex flex-col gap-px">
              {group.items.map((item) => (
                <li key={item.label}>
                  <NavLink
                    item={item}
                    href={base + item.href}
                    active={active === item.href}
                    count={item.countKey ? counts[item.countKey] : undefined}
                    collapsed={collapsed}
                    onNavigate={onNavigate}
                  />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className="shrink-0 border-t border-border p-2">
        {!collapsed ? <UsageSummary orgSlug={orgSlug} onNavigate={onNavigate} /> : null}
        <div className={cn("flex flex-col gap-1", collapsed && "items-center")}>
          <UserMenu collapsed={collapsed} onOpenShortcuts={onOpenShortcuts} />
          {onToggle && collapsed ? (
            <Tooltip side="right" content={<ShortcutLabel label="Expand sidebar" keys={["["]} />}>
              <Button variant="ghost" size="icon" aria-label="Expand sidebar" onClick={onToggle}>
                <SidebarSimpleIcon />
              </Button>
            </Tooltip>
          ) : null}
        </div>
      </div>
    </>
  );
}

function NavLink({
  item,
  href,
  active,
  count,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  href: string;
  active: boolean;
  count?: number;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  const link = (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "focus-ring group relative flex h-8 items-center gap-2.5 rounded-md text-sm transition-colors duration-100",
        collapsed ? "w-8 justify-center" : "px-2",
        active ? "bg-sidebar-accent font-medium text-foreground" : "text-muted-foreground hover:bg-sidebar-hover hover:text-foreground",
      )}
    >
      <Icon
        weight={active ? "fill" : "regular"}
        className={cn("size-4 shrink-0", active ? "text-brand" : "text-subtle-foreground group-hover:text-muted-foreground")}
      />
      {collapsed ? <span className="sr-only">{item.label}</span> : <span className="min-w-0 flex-1 truncate">{item.label}</span>}
      {count ? (
        collapsed ? (
          <span aria-hidden className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-muted-foreground" />
        ) : (
          <span className={cn("text-xs tabular-nums", active ? "text-muted-foreground" : "text-subtle-foreground group-hover:text-muted-foreground")}>
            <span className="sr-only">, </span>
            {count}
            <span className="sr-only"> new</span>
          </span>
        )
      ) : null}
    </Link>
  );

  if (!collapsed) return link;
  return (
    <Tooltip side="right" content={<ShortcutLabel label={count ? `${item.label} · ${count} new` : item.label} keys={["G", item.shortcut]} />}>
      {link}
    </Tooltip>
  );
}

/**
 * Plan usage as one quiet line, not an "Upgrade" card. Neutral until it
 * matters: the meter and the numbers turn warning at 75% and danger at 90%.
 */
function UsageSummary({ orgSlug, onNavigate }: { orgSlug: string; onNavigate?: () => void }) {
  const usage = USAGE[orgSlug];
  if (!usage) return null;
  const ratio = usage.used / usage.limit;
  return (
    <Link
      href={`/orgs/${orgSlug}/billing`}
      onClick={onNavigate}
      className="focus-ring mb-1 block rounded-md px-2 py-2 transition-colors duration-100 hover:bg-sidebar-hover"
    >
      <span className="mb-1.5 flex items-baseline justify-between gap-2 text-xs">
        <span className="truncate text-muted-foreground">{usage.label}</span>
        <span className={cn("shrink-0 tabular-nums", ratio >= 0.9 ? "text-danger" : ratio >= 0.75 ? "text-warning" : "text-subtle-foreground")}>
          {formatCount(usage.used)} of {formatCount(usage.limit)}
        </span>
      </span>
      <Meter value={usage.used} max={usage.limit} label={`${usage.label}: ${formatCount(usage.used)} of ${formatCount(usage.limit)}`} />
    </Link>
  );
}
