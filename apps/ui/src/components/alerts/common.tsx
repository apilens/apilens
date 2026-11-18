import Link from "next/link";
import type { ReactNode } from "react";
import { STATUS_LABEL, incidentsHref, rulesHref, statusTone } from "@/lib/alerts";
import type { AlertStatus } from "@/lib/identity";
import { ObIcon } from "../onboarding/ob";
import { PageHeader } from "../page-header";
import "../org-settings/org-settings.css";
import "./alerts.css";

/**
 * The alerts pages' header (PageHeader, #992) and their two tabs: Incidents and Alert rules. The
 * title is the sidebar's label, Incidents; `section` names a rule or the new rule under it.
 * `children` sit in the actions slot (a button, the range picker).
 */
export function AlertsHeader({
  project,
  projectName,
  tab,
  section,
  lead,
  children,
}: {
  project: string;
  projectName: string;
  tab: "incidents" | "rules";
  section?: string;
  lead?: string;
  children?: ReactNode;
}) {
  return (
    <PageHeader project={project} projectName={projectName} title="Incidents" section={section} lead={lead} actions={children}>
      <nav className="os-tabs" aria-label="Alerts">
        <Link className={`os-tab${tab === "incidents" ? " on" : ""}`} href={incidentsHref(project)} aria-current={tab === "incidents" ? "page" : undefined}>
          Incidents
        </Link>
        <Link className={`os-tab${tab === "rules" ? " on" : ""}`} href={rulesHref(project)} aria-current={tab === "rules" ? "page" : undefined}>
          Alert rules
        </Link>
      </nav>
    </PageHeader>
  );
}

/** A rule's state as a chip: Triggered (error), Pending (warn), Resolving (ok), OK (muted). */
export function StatusBadge({ status, label }: { status: AlertStatus; label?: string }) {
  const tone = statusTone(status);
  return (
    <span className={`ah-badge ${tone === "none" ? "al-badge--none" : `ah-badge--${tone}`}`} data-status={status}>
      {label ?? STATUS_LABEL[status]}
    </span>
  );
}

/** The error state of a read: one sentence and a link that loads the page again. */
export function LoadFailed({ text, href }: { text: string; href: string }) {
  return (
    <div className="al-notice al-notice--error" role="alert">
      <ObIcon name="info" />
      <p>
        {text}{" "}
        <a className="cp-link" href={href}>
          Try again
        </a>
      </p>
    </div>
  );
}

/** The empty state of a list: one sentence, optionally with a next step. */
export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="al-notice" role="status">
      <ObIcon name="info" />
      <p>{children}</p>
    </div>
  );
}
