"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { badgeText } from "@/lib/alerts";
import { sidebarHref } from "@/lib/nav-scope";
import { Icon } from "./icons";

/**
 * The slim bar below 860px (#998): the menu button that opens the sidebar drawer, then where you
 * are (the project or organization, and the page's nav label; account scope has no scope name) and, when any are open, the open
 * incident count linking to Incidents with the current scope.
 */
export function MobileBar({ scope, label, project, openIncidents, onMenu }: { scope: string; label: string; project?: string; openIncidents: number; onMenu: () => void }) {
  const search = useSearchParams();
  const open = badgeText(openIncidents);
  return (
    <div className="app-mobilebar">
      <button type="button" className="cp-sbtn" aria-label="Open navigation" onClick={onMenu}>
        <Icon name="menu" />
      </button>
      <p className="mb-ctx">
        {scope ? <span className="mb-scope">{scope}</span> : null}
        {scope && label ? (
          <span className="mb-sep" aria-hidden="true">
            /
          </span>
        ) : null}
        {label ? <span className="mb-view">{label}</span> : null}
      </p>
      {project && open ? (
        <Link className="mb-badge" href={sidebarHref(project, "incidents", search)} aria-label={`${open} open ${open === "1" ? "incident" : "incidents"}`}>
          {open}
        </Link>
      ) : null}
    </div>
  );
}
