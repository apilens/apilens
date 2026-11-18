"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type KeyboardEvent, type MouseEvent, useId, useState } from "react";
import { type SectionMenuSpec, activeHref, incidentsMenu } from "@/lib/section-menus";
import { useShellOpenIncidents } from "./shell-context";
import { SidePanel } from "./side-panel";

/**
 * The secondary sidebar (#1051), Supabase's "product menu": a section's sub-pages as grouped pill
 * links in a SidePanel next to the icon rail. Render it from the section's `layout.tsx` (through
 * AppShell's `menu`), never from a page: the layout stays mounted while you move between the
 * section's sub-pages, so the menu never remounts, re-animates or shifts; only the content pane
 * changes. Below 860px it renders inside the rail's drawer, under the rail links.
 *
 * Props:
 * - `title`: the section's name, the same words as its rail item and its pages' H1 (Project
 *   settings, Access, Incidents…). It heads the panel and labels the `<nav>`.
 * - `groups`: in order. A group's `title` is shown in UPPERCASE mono (omit it for an untitled
 *   group); groups are split by a hairline.
 *   - `label`, `href`: the item's text and link.
 *   - `active`: forces the item on or off. Without it the item is on when the URL is its `href`
 *     or under it, the longest such `href` winning (so `/settings/privacy` beats `/settings`).
 *     It comes from `usePathname()`, so it changes on click, before the next page's data arrives.
 *   - `badge`: a count at the right edge (0 or "" shows none).
 *   - `hidden`: left out (a sub-page the user may not open, or one not built yet).
 *   - `tone: "danger"`: error ink at rest (Danger zone).
 */
export type { SectionMenuGroup, SectionMenuItem } from "@/lib/section-menus";
export type SectionMenuProps = SectionMenuSpec;

export function SectionMenu({ title, groups }: SectionMenuProps) {
  const path = usePathname() ?? "";
  const id = useId();
  // The item clicked, on at once while its page loads (until the URL changes, from `from`).
  const [pending, setPending] = useState<{ from: string; href: string } | null>(null);
  const pick = (href: string) => (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    setPending({ from: path, href });
  };
  const shown = groups.map((g) => ({ ...g, items: g.items.filter((i) => !i.hidden) })).filter((g) => g.items.length > 0);
  const on = activeHref(
    path,
    shown.flatMap((g) => g.items.filter((i) => i.active === undefined)),
  );

  // Tab moves through the links; the arrow keys, Home and End move between them too.
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const links = Array.from(e.currentTarget.querySelectorAll<HTMLAnchorElement>("a"));
    const i = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (i < 0) return;
    const next = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: links.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    links[(next + links.length) % links.length].focus();
  };

  return (
    <SidePanel title={title}>
      <nav className="sm" aria-label={title} onKeyDown={onKeyDown}>
        {shown.map((g, gi) => (
          <div key={g.title ?? gi} className="sm-group">
            {g.title ? (
              <p className="sm-gt" id={`${id}-${gi}`}>
                {g.title}
              </p>
            ) : null}
            <ul className="sm-list" aria-labelledby={g.title ? `${id}-${gi}` : undefined}>
              {g.items.map((item) => {
                const current = item.active ?? item.href === (pending && pending.from === path ? pending.href : on);
                const badge = item.badge === 0 || item.badge === "" ? undefined : item.badge;
                return (
                  <li key={item.href}>
                    <Link href={item.href} onClick={pick(item.href)} className={`sm-item${current ? " on" : ""}${item.tone === "danger" ? " sm-item--danger" : ""}`} aria-current={current ? "page" : undefined}>
                      <span className="sm-lb">{item.label}</span>
                      {badge !== undefined ? <span className="sm-ct">{badge}</span> : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </SidePanel>
  );
}

/** Incidents' menu: Incidents (badge: the open count the shell keeps) and Alert rules. */
export function IncidentsMenu({ project }: { project: string }) {
  const open = useShellOpenIncidents();
  return <SectionMenu {...incidentsMenu(project, open)} />;
}
