import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { getContext } from "@/lib/auth/server";
import { projectHref } from "@/lib/routes";
import { findProject } from "@/lib/scope";
import "./coming-soon.css";

/**
 * A project section that isn't open yet: the shell with its nav item active, and a short note on
 * what the section will hold, with the pages that already answer part of it.
 */
export async function ComingSoonPage({ project, view, title, blurb }: { project: string; view: string; title: string; blurb: string }) {
  const context = await getContext(projectHref(project, view));
  if (!findProject(context, project)) notFound();
  return (
    <AppShell context={context} project={project} view={view}>
      <div className="page cs-soon">
        <section className="cs-soon__card" aria-labelledby="cs-soon-title">
          <span className="cs-soon__tag">Coming soon</span>
          <h1 id="cs-soon-title">{title}</h1>
          <p>{blurb}</p>
          <p className="cs-soon__meanwhile">
            Meanwhile, <a href={projectHref(project, "traffic")}>Traffic</a> and <a href={projectHref(project, "explore")}>Explore</a> show every request, its status and
            response time.
          </p>
        </section>
      </div>
    </AppShell>
  );
}
