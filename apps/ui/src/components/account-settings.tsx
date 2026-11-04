"use client";

import Link from "next/link";
import { type KeyboardEvent, type ReactNode, useRef } from "react";
import { ACCOUNT_SECTIONS, ACCOUNT_SETTINGS, type AccountSection, accountSectionHref } from "@/lib/account-settings";

/**
 * The account section's frame: breadcrumb (Account / section), a section nav on the left (a row
 * of tabs below 860px) and the section's content. Tab moves through the links; the arrow keys,
 * Home and End move between them too. `children` is the section's content, under its title.
 */
export function AccountSettings({ section, children }: { section: AccountSection; children?: ReactNode }) {
  const nav = useRef<HTMLElement>(null);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const links = Array.from(nav.current?.querySelectorAll<HTMLAnchorElement>("a") ?? []);
    const i = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (i < 0) return;
    const next = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: links.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    links[(next + links.length) % links.length].focus();
  };

  return (
    <div className="app-page acct">
      <nav className="crumbs" aria-label="Breadcrumb">
        <ol>
          <li>
            <Link href="/settings">{ACCOUNT_SETTINGS.crumb}</Link>
          </li>
          <li aria-current="page">{section.label}</li>
        </ol>
      </nav>

      <div className="acct-body">
        <nav ref={nav} className="acct-nav" aria-label={ACCOUNT_SETTINGS.label} onKeyDown={onKeyDown}>
          <ul>
            {ACCOUNT_SECTIONS.map((s) => {
              const on = s.slug === section.slug;
              return (
                <li key={s.slug}>
                  <Link href={accountSectionHref(s)} className={`cp-sitem${on ? " on" : ""}${s.slug === "danger" ? " acct-nav__danger" : ""}`} aria-current={on ? "page" : undefined}>
                    <span className="lb">{s.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <section className="acct-main" aria-labelledby="acct-title">
          <h1 id="acct-title" className="cp-lede">
            {section.label}
          </h1>
          <p className="cp-sub">{section.summary}</p>
          {children}
        </section>
      </div>
    </div>
  );
}
