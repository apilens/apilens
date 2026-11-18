import { ACCESS, type AccessTab } from "@/lib/access";
import { PageHeader } from "../page-header";
import "../org-settings/org-settings.css";

/** An Access sub-page with no content yet (#801): its title and a plain line, never a blank page. */
export function NotBuiltAccessTab({ tab }: { project: string; projectName: string; tab: AccessTab }) {
  return (
    <div className="page page--narrow os">
      <PageHeader title={ACCESS.label} lead={ACCESS.lead} section={tab.label} className="os-head" />
      <p className="cp-sub">Nothing here yet.</p>
    </div>
  );
}
