"use client";

import { useState } from "react";
import { Icon } from "./icons";
import { NavIcon, type NavIconName } from "./nav-icons";
import type { VariantId } from "./nav-variants-data";

type Link = { slug: NavIconName; label: string; count?: string; warn?: boolean };
const LINKS: Link[] = [
  { slug: "incidents", label: "Incidents", count: "1", warn: true },
  { slug: "explore", label: "Explore" },
  { slug: "apps", label: "Apps", count: "3", warn: true },
  { slug: "changes", label: "Changes" },
  { slug: "access", label: "Access" },
  { slug: "settings", label: "Project settings" },
];



/** A static, clickable sidebar for comparing link styles. Only the link style differs per variant. */
export function MiniSidebar({ variant }: { variant: VariantId }) {
  const [active, setActive] = useState<string>("apps");
  return (
    <aside className={`ah nvx nvx-${variant}`} aria-label={`Variant ${variant.toUpperCase()}`}>
      <div className="nvx-org">
        <span className="st-mark">A</span>
        <span className="nvx-orgtxt">
          <b>Acme Retail</b>
          <small>Owner</small>
        </span>
        <Icon name="updown" />
      </div>
      <div className="nvx-proj">
        <NavIcon name="project" />
        <span className="nm">platform</span>
        <span className="meta">5 apps</span>
        <Icon name="updown" />
      </div>
      <nav className="nvx-links">
        {LINKS.map((l) => {
          const on = active === l.slug;
          return (
            <button key={l.slug} type="button" className={`nvx-link${on ? " on" : ""}`} aria-current={on ? "page" : undefined} onClick={() => setActive(l.slug)}>
              <span className="ic">
                <NavIcon name={l.slug} active={on && variant !== "b" && variant !== "c"} />
              </span>
              <span className="lb">{l.label}</span>
              {l.count ? <span className={`ct${l.warn ? " w" : ""}`}>{l.count}</span> : null}
            </button>
          );
        })}
      </nav>
      <div className="nvx-foot">
        <span className="cp-av">AM</span>
        <span className="nvx-me">
          <b>Amit</b>
          <small>amit@motadata.com</small>
        </span>
        <Icon name="panelClose" />
      </div>
    </aside>
  );
}
