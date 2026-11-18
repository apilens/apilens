import Link from "next/link";
import type { ReactNode } from "react";
import { HOME_VIEW } from "@/lib/data";
import "./page-header.css";

/**
 * The one page header (#992, decision D7 of #963): an eyebrow linking the project, the title (the
 * page's sidebar label), an optional section subheading (a settings section or a tab), a lead
 * line, and an actions slot at the right edge that holds the page's range picker or buttons.
 * `children` render under it all (tabs, or a lead with links). `className` keeps the frame's own
 * spacing (`pagehead` on analytics pages, `os-head` in settings frames).
 */
export function PageHeader({
  project,
  projectName,
  title,
  section,
  lead,
  actions,
  badge,
  className = "pagehead",
  children,
}: {
  project: string;
  projectName: string;
  title: string;
  section?: string;
  lead?: ReactNode;
  actions?: ReactNode;
  /** Shown after the project name in the eyebrow (a count or a state). */
  badge?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <header className={`ph ${className}`}>
      <div className="ph-row">
        <div className="ph-text">
          <p className="cp-h ph-eyebrow">
            <Link href={`/${encodeURIComponent(project)}/${HOME_VIEW}`}>{projectName}</Link>
            {badge}
          </p>
          <h1 className="cp-lede">{title}</h1>
          {section ? <h2 className="ph-section">{section}</h2> : null}
          {lead ? <p className="ph-lead">{lead}</p> : null}
        </div>
        {actions ? <div className="ph-actions">{actions}</div> : null}
      </div>
      {children}
    </header>
  );
}
