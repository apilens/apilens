"use client";

import { usePathname } from "next/navigation";
import { type ReactNode, createContext, useContext, useEffect, useState, useTransition } from "react";
import { resumeProjectIngest } from "@/app/[project]/settings/general-actions";
import { useCan } from "@/lib/permissions";
import { ObIcon } from "./onboarding/ob";
import "./paused-banner.css";

/** The project a `/<project>/...` page is under and whether its ingest is paused (#823). */
export type ProjectStatus = { slug: string; paused: boolean };

const ProjectStatusContext = createContext<ProjectStatus | null>(null);

/** Set by `[project]/layout.tsx` from `GET /projects/{slug}`; `AppShell` reads it for the banner. */
export function ProjectStatusProvider({ status, children }: { status: ProjectStatus | null; children?: ReactNode }) {
  return <ProjectStatusContext.Provider value={status}>{children}</ProjectStatusContext.Provider>;
}

/**
 * A thin banner at the top of every page of a paused project (#823), with Resume for those who
 * may resume it (`project.delete`, project admins). Project settings › General has its own fuller
 * notice, so the banner stays off that page. Must render inside `CapabilitiesProvider`.
 */
export function PausedBanner({ project }: { project: string }) {
  const status = useContext(ProjectStatusContext);
  const pathname = usePathname();
  const resume = useCan("project.delete").allowed;
  const [resumed, setResumed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const paused = status?.paused === true;
  // Paused again later (Danger zone): show the banner again.
  useEffect(() => {
    if (paused) setResumed(false);
  }, [paused]);

  if (!status || status.slug !== project || pathname === `/${project}/settings`) return null;
  if (!status.paused || resumed) {
    return resumed ? (
      <p className="pb-sr" role="status">
        Data collection resumed.
      </p>
    ) : null;
  }

  const onResume = () => {
    if (pending) return;
    setError(null);
    start(async () => {
      const result = await resumeProjectIngest(project);
      // The action re-renders the layout too, so General and Danger zone follow.
      if (result.ok) setResumed(true);
      else setError(result.error);
    });
  };

  return (
    <section className="pb" aria-label="Data collection paused">
      <ObIcon name="info" />
      <p className="pb-t">
        <strong>Data collection is paused.</strong> The ingest edge refuses this project’s data; stored data and the dashboard are unaffected.
        {resume ? null : " A project admin can resume it."}
      </p>
      {error ? (
        <p className="pb-err" role="alert">
          {error}
        </p>
      ) : null}
      {resume ? (
        <button type="button" className={`ah-btn ah-btn--ghost ah-btn--sm${pending ? " is-loading" : ""}`} onClick={onResume} disabled={pending}>
          Resume
        </button>
      ) : null}
    </section>
  );
}
