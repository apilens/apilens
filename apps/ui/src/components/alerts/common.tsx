import type { ReactNode } from "react";
import { STATUS_LABEL, statusTone } from "@/lib/alerts";
import type { AlertStatus } from "@/lib/identity";
import { PageHeader } from "../page-header";
import "../org-settings/org-settings.css";
import "./alerts.css";

/** The Incidents section's one-line description (#1051). */
export const INCIDENTS_LEAD = "Alert rules that breached their threshold, and the rules that watch for them.";

/**
 * The alerts pages' title row (PageHeader, #992). The title is the rail's and the section menu's
 * label, Incidents; Incidents and Alert rules are in the section menu (#1051), not tabs. `tab`
 * says which: Alert rules shows as the sub-page under the title, as does `section` (a rule, or
 * the new rule). `lead` replaces the section's description. `children` sit in the actions slot.
 */
export function AlertsHeader({
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
  return <PageHeader title="Incidents" section={section ?? (tab === "rules" ? "Alert rules" : undefined)} lead={lead ?? INCIDENTS_LEAD} actions={children} />;
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
