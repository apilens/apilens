"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { HOME_VIEW } from "@/lib/data";
import { type ContextOrg, type ContextProject, orgHome, orgMark, plural, roleLabel } from "@/lib/scope";
import { Icon } from "../icons";
import { PopMenu } from "../pop-menu";

/** Lists longer than this get a search field, as in Supabase's switchers. */
const SEARCH_FROM = 6;

/**
 * A top bar switcher: the trigger names the current scope; the popover lists the alternatives,
 * filterable once the list is long, with links (settings, all projects) under it.
 */
function Switcher<T extends { slug: string; name: string }>({
  label,
  items,
  current,
  href,
  meta,
  mark,
  trigger,
  name,
  footer,
}: {
  label: string;
  /** The trigger's accessible name. */
  name: string;
  items: T[];
  current: string;
  href: (item: T) => string;
  meta: (item: T) => string;
  mark: (item: T) => string;
  trigger: ReactNode;
  footer?: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const close = () => setOpen(false);
  const search = items.length >= SEARCH_FROM;
  const shown = q.trim() ? items.filter((i) => i.name.toLowerCase().includes(q.trim().toLowerCase())) : items;

  useEffect(() => {
    if (!open) return setQ("");
    if (search) requestAnimationFrame(() => field.current?.focus());
  }, [open, search]);

  return (
    <>
      <button ref={ref} type="button" className={`tb-scope${open ? " is-open" : ""}`} aria-haspopup="menu" aria-expanded={open} aria-label={name} onClick={() => setOpen((o) => !o)}>
        {trigger}
        <Icon name="updown" />
      </button>
      <PopMenu open={open} onClose={close} triggerRef={ref} label={label} align="start">
        {search ? (
          <div className="tb-find">
            <Icon name="search" />
            <input ref={field} value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Find ${label.toLowerCase()}…`} aria-label={`Find ${label.toLowerCase()}`} />
          </div>
        ) : (
          <p className="menu-label">{label === "Organization" ? "Organizations" : "Projects"}</p>
        )}
        {shown.map((i) => (
          <Link key={i.slug} role="menuitemradio" aria-checked={i.slug === current} href={href(i)} className={`cp-org cp-org--row${i.slug === current ? " on" : ""}`} onClick={close}>
            <span className="st-mark">{mark(i)}</span>
            <span className="t">
              <b>{i.name}</b>
              <small>{meta(i)}</small>
            </span>
            {i.slug === current ? (
              <span className="chk">
                <Icon name="check" />
              </span>
            ) : null}
          </Link>
        ))}
        {shown.length === 0 ? <p className="tb-none">No {label.toLowerCase()} matches “{q.trim()}”.</p> : null}
        {footer ? (
          <>
            <hr />
            {footer(close)}
          </>
        ) : null}
      </PopMenu>
    </>
  );
}

function MenuLink({ href, icon, children, onClick }: { href: string; icon: "settings" | "grid"; children: ReactNode; onClick: () => void }) {
  return (
    <Link href={href} role="menuitem" className="cp-sitem" onClick={onClick}>
      <span className="sl">
        <Icon name={icon} />
      </span>
      <span className="lb">{children}</span>
    </Link>
  );
}

/** The organization crumb: its mark, name and your role. Switching opens the org's home. */
export function OrgSelector({ orgs, org, orgScope }: { orgs: ContextOrg[]; org: ContextOrg; orgScope: boolean }) {
  return (
    <Switcher
      label="Organization"
      items={orgs}
      current={org.slug}
      href={(o) => (orgScope ? `/orgs/${o.slug}/settings` : orgHome(o, HOME_VIEW))}
      meta={(o) => `${roleLabel(o.role)} · ${plural(o.projects.length, "project")}`}
      mark={orgMark}
      name={`${org.name}, ${roleLabel(org.role)}. Organization menu`}
      trigger={
        <>
          <span className="st-mark">{orgMark(org)}</span>
          <span className="tb-name">{org.name}</span>
          <span className="tb-badge">{roleLabel(org.role)}</span>
        </>
      }
      footer={(close) => (
        <MenuLink href={`/orgs/${org.slug}/settings`} icon="settings" onClick={close}>
          Organization settings
        </MenuLink>
      )}
    />
  );
}

/** The project crumb. Switching keeps the page you are on. */
export function ProjectSelector({ org, project, view }: { org: ContextOrg; project: ContextProject; view: string }) {
  return (
    <Switcher
      label="Project"
      items={org.projects}
      current={project.slug}
      href={(p) => `/${p.slug}/${view || HOME_VIEW}`}
      meta={(p) => plural(p.app_count, "app")}
      mark={(p) => p.name[0].toUpperCase()}
      name={`Project ${project.name}. Switch project`}
      trigger={<span className="tb-name">{project.name}</span>}
      footer={(close) => (
        <MenuLink href={`/${project.slug}/settings`} icon="settings" onClick={close}>
          Project settings
        </MenuLink>
      )}
    />
  );
}
