import type { ReactNode } from "react";
import type { AccessTab } from "@/lib/access";
import { PageHeader } from "../page-header";
import "../org-settings/org-settings.css";

/** An Access tab with no content yet (#801): its title, the tabs and a plain line, never a blank page. */
export function NotBuiltAccessTab({ project, projectName, tab, nav }: { project: string; projectName: string; tab: AccessTab; nav: ReactNode }) {
  return (
    <div className="page page--measure os">
      <PageHeader project={project} projectName={projectName} title="Access" className="os-head">
        {nav}
      </PageHeader>
      <p className="cp-sub">Nothing here yet.</p>
    </div>
  );
}
