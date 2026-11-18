"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { orgHref } from "@/lib/routes";
import { type ContextOrg, orgMark, plural, roleLabel } from "@/lib/scope";
import { PageHeader } from "../page-header";
import "../org-settings/org-settings.css";
import "./org.css";

/** The organizations whose name or slug holds `q` (case-insensitive); all of them for an empty `q`. */
export function matchOrgs(orgs: readonly ContextOrg[], q: string): ContextOrg[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [...orgs];
  return orgs.filter((o) => o.name.toLowerCase().includes(needle) || o.slug.includes(needle));
}

/**
 * `/organizations`, Supabase's (`routes/_app/organizations.tsx`): no rail, a centred page at most
 * 1200px wide, "Your organizations", a search box, then one card per organization in a grid
 * (one, two or three columns) with your role and how many of its projects you can see; each opens
 * the organization's projects (`/org/<org>`). A search that matches nothing says so.
 */
export function Organizations({ orgs }: { orgs: ContextOrg[] }) {
  const [q, setQ] = useState("");
  const searchId = useId();
  const shown = matchOrgs(orgs, q);
  return (
    <div className="page os org-page org-page--all">
      <PageHeader title="Your organizations" lead={`${plural(orgs.length, "organization")} you belong to, with your role in each.`} />

      <div className="org-tools">
        <label className="org-search" htmlFor={searchId}>
          <span className="org-sr">Search for an organization</span>
          <input id={searchId} type="search" placeholder="Search for an organization" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
        </label>
      </div>

      {shown.length === 0 ? (
        <div className="org-empty" role="status">
          <p className="org-empty__t">No organizations match “{q.trim()}”</p>
          <p className="org-empty__p">Search by an organization’s name or slug.</p>
        </div>
      ) : (
        <ul className="org-grid org-grid--all" aria-label="Organizations">
          {shown.map((o) => (
            <li key={o.slug}>
              <Link href={orgHref(o.slug)} className="org-card org-card--row">
                <span className="st-mark org-card__mark" aria-hidden="true">
                  {orgMark(o)}
                </span>
                <span className="org-card__t">
                  <b>{o.name}</b>
                  <span className="org-card__sub">
                    {roleLabel(o.role)} · {plural(o.projects.length, "project")}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
