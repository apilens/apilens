"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { HOME_VIEW, appsOf } from "@/lib/data";
import { type ContextOrg, type ContextProject, orgHome, orgMark, plural, roleLabel } from "@/lib/scope";
import { Icon } from "./icons";
import { PopMenu } from "./pop-menu";



/** Top of the sidebar: the organization (switch, settings, create). Collapsed: the mark only. */
export function OrgHeader({ orgs, org, orgScope, collapsed }: { orgs: ContextOrg[]; org: ContextOrg; orgScope: boolean; collapsed: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);
  return (
    <>
      <button ref={ref} type="button" className={`oh${open ? " is-open" : ""}`} aria-haspopup="menu" aria-expanded={open} aria-label={`${org.name}, ${roleLabel(org.role)}. Organization menu`} data-tip={collapsed && !open ? org.name : undefined} onClick={() => setOpen((o) => !o)}>
        <span className="st-mark">{orgMark(org)}</span>
        <span className="oh-txt">
          <b>{org.name}</b>
          <small>Organization · {roleLabel(org.role)}</small>
        </span>
        <Icon name="updown" />
      </button>
      <PopMenu open={open} onClose={close} triggerRef={ref} label="Organization" align={collapsed ? "side" : "start"}>
        <p className="menu-label">Organizations</p>
        {orgs.map((o) => (
          <Link key={o.slug} role="menuitemradio" aria-checked={o.slug === org.slug} href={orgScope ? `/orgs/${o.slug}/settings` : orgHome(o, HOME_VIEW)} className={`cp-org cp-org--row${o.slug === org.slug ? " on" : ""}`} onClick={close}>
            <span className="st-mark">{orgMark(o)}</span>
            <span className="t">
              <b>{o.name}</b>
              <small>
                {roleLabel(o.role)} · {plural(o.projects.length, "project")}
              </small>
            </span>
            {o.slug === org.slug ? (
              <span className="chk">
                <Icon name="check" />
              </span>
            ) : null}
          </Link>
        ))}
        <hr />
        <Link href={`/orgs/${org.slug}/settings`} role="menuitem" className="cp-sitem" onClick={close}>
          <span className="sl">
            <Icon name="settings" />
          </span>
          <span className="lb">Organization settings</span>
        </Link>
        <button type="button" role="menuitem" className="cp-sitem" onClick={close}>
          <span className="sl">
            <Icon name="plus" />
          </span>
          <span className="lb">Create organization</span>
        </button>
      </PopMenu>
    </>
  );
}

/** Under the organization: the project, switchable within the org. */
export function ProjectRow({ org, project, view, collapsed = false }: { org: ContextOrg; project: ContextProject; view: string; collapsed?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={ref} type="button" className={`oh oh--project${open ? " is-open" : ""}`} aria-haspopup="menu" aria-expanded={open} aria-label={`Project ${project.name}. Switch project`} data-tip={collapsed && !open ? project.name : undefined} onClick={() => setOpen((o) => !o)}>
        <span className="st-mark st-mark--project">{project.name[0].toUpperCase()}</span>
        <span className="oh-txt">
          <b>{project.name}</b>
          <small>
            Project · {appsOf(project.slug).length} {appsOf(project.slug).length === 1 ? "app" : "apps"}
          </small>
        </span>
        <Icon name="updown" />
      </button>
      <PopMenu open={open} onClose={() => setOpen(false)} triggerRef={ref} label="Projects" align={collapsed ? "side" : "start"}>
        <p className="menu-label">Projects</p>
        {org.projects.map((p) => {
          const apps = appsOf(p.slug).length;
          return (
            <Link key={p.slug} role="menuitemradio" aria-checked={p.slug === project.slug} href={`/${p.slug}/${view || HOME_VIEW}`} className={`cp-org cp-org--row${p.slug === project.slug ? " on" : ""}`} onClick={() => setOpen(false)}>
              <span className="st-mark st-mark--project">{p.name[0].toUpperCase()}</span>
              <span className="t">
                <b>{p.name}</b>
                <small>
                  {apps} {apps === 1 ? "app" : "apps"}
                </small>
              </span>
              {p.slug === project.slug ? (
                <span className="chk">
                  <Icon name="check" />
                </span>
              ) : null}
            </Link>
          );
        })}
        <hr />
        <Link href={`/${project.slug}/settings`} role="menuitem" className="cp-sitem" onClick={() => setOpen(false)}>
          <span className="sl"><Icon name="settings" /></span>
          <span className="lb">Project settings</span>
        </Link>
        <button type="button" role="menuitem" className="cp-sitem" onClick={() => setOpen(false)}>
          <span className="sl"><Icon name="plus" /></span>
          <span className="lb">Create project</span>
        </button>
      </PopMenu>
    </>
  );
}
