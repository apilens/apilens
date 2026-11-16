import type { ReactNode } from "react";
import type { AccessTab } from "@/lib/access";
import "../org-settings/org-settings.css";

/** An Access tab with no content yet (#801): its title, the tabs and a plain line, never a blank page. */
export function NotBuiltAccessTab({ projectName, tab, nav }: { projectName: string; tab: AccessTab; nav: ReactNode }) {
  return (
    <div className="page page--measure os">
      <header className="os-head">
        <p className="cp-h">{projectName} · Access</p>
        <h1 className="cp-lede">{tab.label}</h1>
        {nav}
      </header>
      <p className="cp-sub">Nothing here yet.</p>
    </div>
  );
}
