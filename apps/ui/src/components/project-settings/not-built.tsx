import type { ProjectSection } from "@/lib/project-settings";
import { PROJECT_SETTINGS } from "@/lib/data";
import { PageHeader } from "../page-header";
import "../org-settings/org-settings.css";

/** A project settings section with no content yet (#800): its title and a plain line, never a blank page. */
export function NotBuiltSection({ project, projectName, section }: { project: string; projectName: string; section: ProjectSection }) {
  return (
    <div className="page page--measure os">
      <PageHeader title={PROJECT_SETTINGS.label} lead={PROJECT_SETTINGS.lead} section={section.label} className="os-head" />
      <p className="cp-sub">Nothing here yet.</p>
    </div>
  );
}
