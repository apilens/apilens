import {
  BellIcon,
  BroadcastIcon,
  BuildingsIcon,
  CreditCardIcon,
  GaugeIcon,
  GearSixIcon,
  PathIcon,
  SquaresFourIcon,
  StackIcon,
  TreeStructureIcon,
  UsersThreeIcon,
  WarningIcon,
  type IconComponent,
} from "@/components/ui/icon";

// One source for navigation: the sidebar, the mobile sheet, the keyboard
// shortcuts and the placeholder routes all read from here, so they can't drift.
//
// Grouping follows the job, not the data model: watch it (Monitor), dig into
// it (Explore), configure it (Project). Labels are nouns, sentence case.

export interface NavItem {
  label: string;
  /** Path below the scope root ("" = the scope's home). */
  href: string;
  icon: IconComponent;
  /** Second key of the `G then <key>` shortcut. */
  shortcut: string;
  /** Key into NAV_COUNTS. Counts only for things that need action. */
  countKey?: string;
}

export interface NavGroup {
  label: string | null;
  items: NavItem[];
}

export const PROJECT_NAV: NavGroup[] = [
  { label: null, items: [{ label: "Overview", href: "", icon: SquaresFourIcon, shortcut: "O" }] },
  {
    label: "Monitor",
    items: [
      { label: "Traffic", href: "/traffic", icon: GaugeIcon, shortcut: "T" },
      { label: "Errors", href: "/errors", icon: WarningIcon, shortcut: "E", countKey: "errors" },
      { label: "Live tail", href: "/live", icon: BroadcastIcon, shortcut: "L" },
    ],
  },
  {
    label: "Explore",
    items: [
      { label: "Endpoints", href: "/endpoints", icon: PathIcon, shortcut: "N" },
      { label: "Traces", href: "/traces", icon: TreeStructureIcon, shortcut: "R" },
      { label: "Consumers", href: "/consumers", icon: UsersThreeIcon, shortcut: "C" },
    ],
  },
  {
    label: "Project",
    items: [
      { label: "Alerts", href: "/alerts", icon: BellIcon, shortcut: "A" },
      { label: "Settings", href: "/settings", icon: GearSixIcon, shortcut: "S" },
    ],
  },
];

/** Organization scope: billing and access live here, never inside a project. */
export const ORG_NAV: NavGroup[] = [
  {
    label: null,
    items: [{ label: "Projects", href: "/projects", icon: StackIcon, shortcut: "P" }],
  },
  {
    label: "Organization",
    items: [
      { label: "Members", href: "/members", icon: UsersThreeIcon, shortcut: "M" },
      { label: "Usage & billing", href: "/billing", icon: CreditCardIcon, shortcut: "B" },
      { label: "Settings", href: "/settings", icon: BuildingsIcon, shortcut: "S" },
    ],
  },
];

export const PROJECT_ITEMS = PROJECT_NAV.flatMap((g) => g.items);
export const ORG_ITEMS = ORG_NAV.flatMap((g) => g.items);

/** Path prefix for a scope. */
export const scopeBase = (scope: Scope) => (scope.kind === "project" ? `/projects/${scope.slug}` : `/orgs/${scope.slug}`);

export type Scope = { kind: "project"; slug: string; orgSlug: string } | { kind: "org"; slug: string };

/** Which item is active for a pathname. Longest matching href wins. */
export function activeHref(items: NavItem[], base: string, pathname: string): string | null {
  const rest = pathname.startsWith(base) ? pathname.slice(base.length) : null;
  if (rest === null) return null;
  const match = items
    .filter((i) => (i.href === "" ? rest === "" || rest === "/" : rest === i.href || rest.startsWith(i.href + "/")))
    .sort((a, b) => b.href.length - a.href.length)[0];
  return match ? match.href : null;
}

/** Cookie that remembers the collapsed rail, read on the server so there's no flash. */
export const SIDEBAR_COOKIE = "ap_sidebar";
