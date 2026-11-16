import type { ProjectSection } from "@/lib/project-settings";
import "../org-settings/org-settings.css";

/** A project settings section with no content yet (#800): its title and a plain line, never a blank page. */
export function NotBuiltSection({ projectName, section }: { projectName: string; section: ProjectSection }) {
  return (
    <div className="page page--measure os">
      <header className="os-head">
        <p className="cp-h">{projectName} · Settings</p>
        <h1 className="cp-lede">{section.label}</h1>
      </header>
      <p className="cp-sub">Nothing here yet.</p>
    </div>
  );
}
