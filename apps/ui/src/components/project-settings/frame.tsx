"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type KeyboardEvent, type ReactNode, useId, useRef } from "react";
import { PROJECT_SETTINGS } from "@/lib/data";
import { PROJECT_SETTINGS_GROUPS, type ProjectSection, projectSectionHref } from "@/lib/project-settings";
import "./frame.css";

/**
 * The project settings frame (#800): the section nav on the left, grouped (a select below 860px),
 * and the section's content. Tab moves through the links; the arrow keys, Home and End move
 * between them too. `sections` are the ones the user may see, in order; `children` is the
 * section's own page, which keeps its own title.
 */
export function ProjectSettingsFrame({ project, sections, current, children }: { project: string; sections: readonly ProjectSection[]; current: string; children?: ReactNode }) {
  const nav = useRef<HTMLElement>(null);
  const router = useRouter();
  const pickId = useId();

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const links = Array.from(nav.current?.querySelectorAll<HTMLAnchorElement>("a") ?? []);
    const i = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (i < 0) return;
    const next = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: links.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    links[(next + links.length) % links.length].focus();
  };

  const groups = PROJECT_SETTINGS_GROUPS.map((group) => ({ group, items: sections.filter((s) => s.group === group) })).filter((g) => g.items.length > 0);

  return (
    <div className="page psf">
      <div className="psf-body">
        <nav ref={nav} className="psf-nav" aria-label={PROJECT_SETTINGS.label} onKeyDown={onKeyDown}>
          {groups.map(({ group, items }) => (
            <div key={group} className="psf-group">
              <p className="psf-gh" id={`${pickId}-${group}`}>
                {group}
              </p>
              <ul aria-labelledby={`${pickId}-${group}`}>
                {items.map((s) => {
                  const on = s.slug === current;
                  return (
                    <li key={s.slug}>
                      <Link href={projectSectionHref(project, s)} className={`cp-sitem${on ? " on" : ""}${s.danger ? " psf-nav__danger" : ""}`} aria-current={on ? "page" : undefined}>
                        <span className="lb">{s.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="psf-pick">
          <label htmlFor={pickId}>Section</label>
          <select id={pickId} className="psf-select" value={current} onChange={(e) => router.push(projectSectionHref(project, { slug: e.target.value }))}>
            {groups.map(({ group, items }) => (
              <optgroup key={group} label={group}>
                {items.map((s) => (
                  <option key={s.slug} value={s.slug}>
                    {s.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        <div className="psf-main">{children}</div>
      </div>
    </div>
  );
}
