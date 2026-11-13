"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState, useTransition } from "react";
import { deleteProjectNow, pauseProjectIngest, renameProjectSlug } from "@/app/[project]/settings/danger-actions";
import { resumeProjectIngest } from "@/app/[project]/settings/general-actions";
import type { ProjectDetail } from "@/lib/identity";
import { PROJECT_SLUG_CHECK_PATH, type SlugStatus, checkableSlug, createSlugChecker } from "@/lib/org-slug";
import { formatDay, formatExact } from "@/lib/passkey-settings";
import { useCan } from "@/lib/permissions";
import { renameSlugError } from "@/lib/project-general";
import { REAUTH_CANCELLED } from "@/lib/reauth";
import { ConfirmDialog } from "../confirm-dialog";
import { ObIcon } from "../onboarding/ob";
import { useReauth } from "../reauth-dialog";
import "../org-settings/org-settings.css";
import "./danger.css";

/** The project as `GET /projects/{slug}` answers it; null when the API could not answer. */
export type DangerLoad = ProjectDetail | null;

type Status = { tone: "ok" | "err"; text: string } | null;
type Dialog = "pause" | "rename" | "delete" | null;

/** Why the actions are disabled for those without `project.delete`. */
const ADMINS_ONLY = "Only project admins can pause, rename or delete this project. Ask a project admin.";

/** Where a deleted project's admin lands: the organization's projects, with a status message. */
export function deletedHref(org: string, slug: string): string {
  return `/orgs/${encodeURIComponent(org)}/settings?${new URLSearchParams({ deleted: slug })}`;
}

/**
 * `/<project>/settings/danger` (#821): pause data collection (typed project name; resume needs no
 * confirmation), change the project slug (availability checked as in onboarding; old links
 * redirect) and delete the project (typed slug; restorable for 7 days). Gated by
 * `project.delete`: everyone else sees the rows with the actions disabled and the reason.
 */
export function ProjectDangerZone({
  project,
  projectName,
  org,
  loaded,
  renamedFrom = null,
}: {
  project: string;
  projectName: string;
  org: string;
  loaded: DangerLoad;
  renamedFrom?: string | null;
}) {
  return (
    <div className="page page--measure os pdz">
      <header className="os-head">
        <p className="cp-h">{projectName} · Settings</p>
        <h1 className="cp-lede">Danger zone</h1>
      </header>
      {loaded === null ? (
        <p className="pk-load-err" role="alert">
          Couldn’t load this project’s settings. Reload the page to try again.
        </p>
      ) : (
        <DangerBody key={loaded.id} project={project} org={org} initial={loaded} renamedFrom={renamedFrom} />
      )}
    </div>
  );
}

function DangerBody({ project, org, initial, renamedFrom }: { project: string; org: string; initial: ProjectDetail; renamedFrom: string | null }) {
  const router = useRouter();
  const allowed = useCan("project.delete").allowed;
  const [current, setCurrent] = useState(initial);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>(renamedFrom ? { tone: "ok", text: `Slug changed. Links to /${renamedFrom} now redirect here.` } : null);
  const [pending, start] = useTransition();
  const [slug, setSlug] = useState("");
  const [slugError, setSlugError] = useState<string | null>(null);
  const [checked, setChecked] = useState<{ slug: string; status: SlugStatus } | null>(null);
  const checker = useRef<ReturnType<typeof createSlugChecker> | null>(null);
  // Renaming and deleting need a recent sign-in (D12): reauth_required opens the dialog, then retries once.
  const { withReauth, dialog: reauthDialog } = useReauth();
  const reason = allowed ? undefined : "pdz-reason";

  useEffect(() => {
    const c = createSlugChecker({ path: PROJECT_SLUG_CHECK_PATH, onResult: (s, st) => setChecked({ slug: s, status: st }) });
    checker.current = c;
    return () => c.cancel();
  }, []);

  const wanted = slug.trim();
  const slugStatus: SlugStatus =
    checked?.slug === wanted ? checked.status : checkableSlug(wanted) && wanted !== current.slug ? { kind: "checking" } : { kind: "idle" };

  const open = (which: Exclude<Dialog, null>) => {
    setDialogError(null);
    setStatus(null);
    setDialog(which);
  };
  const close = () => {
    if (pending) return;
    setDialog(null);
    setDialogError(null);
  };

  const onPause = (typed: string) => {
    start(async () => {
      const result = await withReauth(() => pauseProjectIngest(project, typed));
      if (result.ok) {
        setCurrent(result.project);
        setDialog(null);
        setStatus({ tone: "ok", text: "Data collection paused. The ingest edge now refuses this project’s data." });
      } else if (result.code !== REAUTH_CANCELLED) setDialogError(result.error);
    });
  };

  const onResume = () => {
    if (pending) return;
    setStatus(null);
    start(async () => {
      const result = await resumeProjectIngest(project);
      if (result.ok) {
        setCurrent(result.project);
        setStatus({ tone: "ok", text: "Data collection resumed." });
      } else setStatus({ tone: "err", text: result.error });
    });
  };

  const changeSlug = (value: string) => {
    const next = value.toLowerCase().replace(/\s+/g, "-");
    setSlug(next);
    setSlugError(null);
    setStatus(null);
    if (next.trim() !== current.slug) checker.current?.check(next.trim());
  };

  const askRename = (e: FormEvent) => {
    e.preventDefault();
    if (!allowed || pending) return;
    const problem = renameSlugError(current.slug, wanted);
    if (problem) {
      setSlugError(problem);
      document.getElementById("pdz-slug")?.focus();
      return;
    }
    if (slugStatus.kind === "taken") {
      setSlugError("That slug is taken or reserved. Try another one.");
      return;
    }
    open("rename");
  };

  const onRename = () => {
    start(async () => {
      const result = await withReauth(() => renameProjectSlug(project, wanted));
      if (result.ok) {
        // The URL carries the slug: go to the same section under the new one.
        router.replace(`/${result.project.slug}/settings/danger?${new URLSearchParams({ renamed: current.slug })}`);
      } else if (result.code !== REAUTH_CANCELLED) setDialogError(result.error);
    });
  };

  const onDelete = (typed: string) => {
    start(async () => {
      const result = await withReauth(() => deleteProjectNow(project, typed));
      if (result.ok) router.replace(deletedHref(org, result.deleted.slug));
      else if (result.code !== REAUTH_CANCELLED) setDialogError(result.error);
    });
  };

  const paused = current.paused_at !== null;

  return (
    <>
      {allowed ? null : (
        <p className="os-note">
          <ObIcon name="lock" />
          <span id="pdz-reason">{ADMINS_ONLY}</span>
        </p>
      )}
      <section className="os-card os-card--danger" aria-labelledby="pdz-title">
        <div className="os-card__head">
          <h2 id="pdz-title">Pause, rename or delete</h2>
        </div>
        <div className="os-card__body pdz-rows">
          <div className="os-danger pdz-row">
            {paused ? (
              <p className="t">
                <b>Data collection is paused</b>
                Since{" "}
                <time dateTime={current.paused_at ?? undefined} title={current.paused_at ? formatExact(current.paused_at) : undefined}>
                  {current.paused_at ? formatDay(current.paused_at) : ""}
                </time>
                , the ingest edge refuses data sent with this project’s keys. Resume to accept it again.
              </p>
            ) : (
              <p className="t">
                <b>Pause data collection</b>
                The ingest edge refuses data sent with this project’s keys until you resume. Stored data and the dashboard stay as they are.
              </p>
            )}
            {paused ? (
              <button type="button" className={`ah-btn ah-btn--sm ah-btn--primary${pending && dialog === null ? " is-loading" : ""}`} onClick={onResume} disabled={!allowed || pending} aria-describedby={reason}>
                Resume data collection
              </button>
            ) : (
              <button type="button" className="ah-btn ah-btn--sm os-btn-outline-danger" onClick={() => open("pause")} disabled={!allowed || pending} aria-describedby={reason}>
                Pause data collection
              </button>
            )}
          </div>

          <form className="pdz-row pdz-rename" onSubmit={askRename} noValidate aria-labelledby="pdz-rename-t">
            <div className="os-danger">
              <p className="t">
                <b id="pdz-rename-t">Change project slug</b>
                Links to /{current.slug} redirect to the new slug, and /{current.slug} stays reserved for 30 days. SDKs use API keys, so they keep working unchanged.
              </p>
            </div>
            <div className="pdz-slug">
              <div className="ob-f">
                <label className="ob-l" htmlFor="pdz-slug">
                  New slug
                </label>
                <div className={`ob-in${slugError || slugStatus.kind === "taken" ? " bad" : ""}${allowed ? "" : " ro"}`}>
                  <ObIcon name="link" />
                  <input
                    id="pdz-slug"
                    value={slug}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder={current.slug}
                    maxLength={63}
                    disabled={!allowed || pending}
                    onChange={(e) => changeSlug(e.target.value)}
                    aria-invalid={slugError || slugStatus.kind === "taken" ? true : undefined}
                    aria-describedby={[slugError || slugStatus.kind === "taken" ? "pdz-slug-err" : "", reason ?? ""].filter(Boolean).join(" ") || undefined}
                  />
                  <span className="r" aria-live="polite">
                    {slugError ? null : slugStatus.kind === "available" ? (
                      <>
                        <ObIcon name="done" />
                        Available
                      </>
                    ) : slugStatus.kind === "checking" ? (
                      <span className="pdz-muted">Checking…</span>
                    ) : slugStatus.kind === "taken" ? (
                      <span className="pdz-bad">Taken</span>
                    ) : null}
                  </span>
                </div>
                {slugError ? (
                  <p id="pdz-slug-err" className="ob-err">
                    {slugError}
                  </p>
                ) : slugStatus.kind === "taken" ? (
                  <p id="pdz-slug-err" className="ob-err">
                    That slug is taken or reserved.
                    {slugStatus.suggestions.length > 0 ? ` Try ${slugStatus.suggestions.join(", ")}.` : " Project slugs are unique across APILens."}
                  </p>
                ) : null}
              </div>
              <button type="submit" className="ah-btn ah-btn--sm os-btn-outline-danger" disabled={!allowed || pending || wanted === ""} aria-describedby={reason}>
                Change slug
              </button>
            </div>
          </form>

          <div className="os-danger pdz-row">
            <p className="t">
              <b>Delete project</b>
              It disappears for everyone and ingest stops right away. Its data is removed after 7 days; until then an organization admin can restore it.
            </p>
            <button type="button" className="ah-btn ah-btn--sm os-btn-outline-danger" onClick={() => open("delete")} disabled={!allowed || pending} aria-describedby={reason}>
              Delete project
            </button>
          </div>
        </div>
        <div className="os-card__foot pdz-foot">
          <span className={`os-status${status ? ` ${status.tone}` : ""}`} role="status" aria-live="polite">
            {status?.text ?? ""}
          </span>
        </div>
      </section>

      <ConfirmDialog
        open={dialog === "pause"}
        title={`Pause data collection for ${current.name}?`}
        phrase={current.name}
        actionLabel="Pause data collection"
        pending={pending}
        error={dialog === "pause" ? dialogError : null}
        onConfirm={onPause}
        onCancel={close}
      >
        <p>The ingest edge refuses data sent with this project’s keys until someone resumes it. Data sent while paused is not stored. Stored data and the dashboard stay as they are.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog === "rename"}
        title={`Change the slug to ${wanted}?`}
        actionLabel="Change slug"
        pending={pending}
        error={dialog === "rename" ? dialogError : null}
        onConfirm={onRename}
        onCancel={close}
      >
        <p>
          The project moves to /{wanted}. Links to /{current.slug} redirect there, and /{current.slug} stays reserved for this project for 30 days. SDKs use API keys,
          so they keep working unchanged.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog === "delete"}
        title={`Delete ${current.name}?`}
        phrase={current.slug}
        actionLabel={`Delete ${current.name}`}
        pending={pending}
        error={dialog === "delete" ? dialogError : null}
        onConfirm={onDelete}
        onCancel={close}
      >
        <p>
          {current.name} disappears for everyone and the ingest edge stops accepting its data right away. Its data is removed after 7 days; until then an
          organization admin can restore it from the organization’s settings.
        </p>
      </ConfirmDialog>
      {reauthDialog}
    </>
  );
}
