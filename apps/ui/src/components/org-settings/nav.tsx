import type { ReactNode } from "react";
import { ORG_SETTINGS } from "@/lib/data";
import type { OrgRole } from "@/lib/identity";
import type { OrgSettingsSection } from "@/lib/org-settings";
import { PageHeader } from "../page-header";
import "./org-settings.css";

/**
 * An organization settings page (#347, #1051): the page anatomy's title row (Organization
 * settings, the section menu's header) with the section's name under it, then `children`. The
 * section menu (General, SSO, Audit log) comes from `app/org/[org]/(settings)/layout.tsx`.
 * `measure` makes it a narrow page (forms); without it the page fills the content pane (the
 * audit log's table). `org`, `role` and `current` are kept for callers; the menu reads them now.
 */
export function OrgSettingsFrame({
  title,
  measure = false,
  className,
  children,
}: {
  org: string;
  role: OrgRole;
  current: OrgSettingsSection["slug"];
  title: string;
  measure?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={["page os", measure ? "page--narrow" : "", className].filter(Boolean).join(" ")}>
      <PageHeader title={ORG_SETTINGS.label} lead={ORG_SETTINGS.lead} section={title} />
      {children}
    </div>
  );
}
