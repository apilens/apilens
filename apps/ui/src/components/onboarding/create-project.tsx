"use client";

import { unstable_rethrow } from "next/navigation";
import { Fragment, type KeyboardEvent, useEffect, useRef, useState, useTransition } from "react";
import { createProject } from "@/app/(auth)/onboarding/project/actions";
import type { OnboardingAnswers } from "@/lib/identity";
import { PROJECT_SLUG_CHECK_PATH, type SlugStatus, checkableSlug, createSlugChecker, slugify } from "@/lib/org-slug";
import { type CreateProjectResult, DEFAULT_ENVIRONMENTS, addEnvironments, createProjectError, envError } from "@/lib/project-create";
import { BackNext, ObIcon, ObShell, type StepProps, describedBy } from "./ob";
import { useOnboardingContinue, useOnboardingToast } from "./progress";
import "@/components/invite-input.css";

const FAILED: CreateProjectResult = { ok: false, code: "unknown_error", error: createProjectError("unknown_error") };

/** A project the organization already has, as the page hands it over. */
export interface ExistingProject {
  slug: string;
  name: string;
  environments: string[];
}

/**
 * "Create your first project" (#331). The name suggests the address, which is checked as the user
 * types (`GET /projects/slug-available`: project addresses are globally unique). Environments are
 * chips, production and staging to start with; Enter, comma or space adds what is typed. Create
 * calls `POST /orgs/{org}/projects` and continues to the instrument step with the address saved
 * as `project_slug`. `answers` are the saved onboarding answers (#327): coming back resumes on
 * the project already created. `org` is the organization the project goes into; `existing` its
 * projects (their addresses are "yours", not "taken").
 */
export function CreateProject({
  step = 2,
  reached = step,
  answers = {},
  host = "",
  org = { slug: "", name: "" },
  existing = [],
}: Partial<StepProps> & { answers?: OnboardingAnswers; host?: string; org?: { slug: string; name: string }; existing?: ExistingProject[] }) {
  const saved = existing.find((p) => p.slug === answers.project_slug);
  const [name, setName] = useState(saved?.name ?? "");
  const [slug, setSlug] = useState(answers.project_slug ?? "");
  const [edited, setEdited] = useState(Boolean(answers.project_slug));
  const [envs, setEnvs] = useState<string[]>(saved?.environments.length ? saved.environments : DEFAULT_ENVIRONMENTS);
  const [draft, setDraft] = useState("");
  const [envErr, setEnvErr] = useState<string | null>(null);
  const [checked, setChecked] = useState<{ slug: string; status: SlugStatus } | null>(null);
  const { go, pending } = useOnboardingContinue(reached);
  const [creating, startCreating] = useTransition();
  const toast = useOnboardingToast();
  const envInput = useRef<HTMLInputElement>(null);
  const address = edited ? slug : slugify(name);
  const mine = existing.some((p) => p.slug === address);

  const checker = useRef<ReturnType<typeof createSlugChecker> | null>(null);
  useEffect(() => {
    const c = createSlugChecker({ path: PROJECT_SLUG_CHECK_PATH, onResult: (s, status) => setChecked({ slug: s, status }) });
    checker.current = c;
    return () => c.cancel();
  }, []);
  useEffect(() => {
    if (mine) checker.current?.cancel();
    else checker.current?.check(address);
  }, [address, mine]);

  const status: SlugStatus =
    checked?.slug === address ? checked.status : checkableSlug(address) && !mine ? { kind: "checking" } : { kind: "idle" };
  const taken = status.kind === "taken";
  const busy = pending || creating;
  const ok =
    name.trim().length > 1 &&
    checkableSlug(address) &&
    (mine || status.kind === "available" || status.kind === "unknown") &&
    (envs.length > 0 || draft.trim() !== "");

  const pick = (s: string) => {
    setEdited(true);
    setSlug(s);
  };

  /** Adds what is typed; answers the list to create with, or null when an entry was refused. */
  const commit = (text: string): string[] | null => {
    if (!text.trim()) return envs;
    const res = addEnvironments(envs, text);
    setEnvs(res.envs);
    if (res.error && res.rejected !== undefined) {
      setEnvErr(envError(res.error, res.rejected));
      setDraft(res.error === "full" ? "" : text.slice(text.indexOf(res.rejected)));
      return null;
    }
    setEnvErr(null);
    setDraft("");
    return res.envs;
  };

  const remove = (env: string) => {
    setEnvs(envs.filter((e) => e !== env));
    setEnvErr(null);
    envInput.current?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const typed = draft.trim() !== "";
    if ((e.key === "Enter" || e.key === "," || e.key === ";" || e.key === " ") && typed) {
      e.preventDefault();
      commit(draft);
    } else if (e.key === "Backspace" && draft === "" && envs.length > 0) {
      e.preventDefault();
      setEnvs(envs.slice(0, -1));
      setEnvErr(null);
    }
  };

  const create = () =>
    startCreating(async () => {
      const list = commit(draft);
      if (!list || list.length === 0) return;
      const target = address;
      const res = await createProject(org.slug, name, target, list).catch((err: unknown) => {
        unstable_rethrow(err);
        return FAILED;
      });
      if (res.ok) {
        go("instrument", "/onboarding/instrument", { project_slug: res.slug });
        return;
      }
      if ("suggestions" in res) {
        // Taken between the check and the click: say so on the field, with the API's suggestions.
        setChecked({ slug: target, status: { kind: "taken", suggestions: res.suggestions, raced: true } });
        return;
      }
      toast(res.error);
    });

  return (
    <ObShell
      eyebrow="02:28 AM"
      headline={["Was it staging", "or production?"]}
      body="Every request carries its environment, so nobody debugs the wrong one."
      receipt={
        <>
          env · <b>production</b> · 3 of 214 requests failing
        </>
      }
      progress={46.67}
      step={step}
      reached={reached}
      badge="folder"
      title="Create your first project"
      lead={
        <>
          One project per product or service you monitor, in <b>{org.name}</b>.
        </>
      }
      footer={<BackNext back="/onboarding/create" nextLabel="Create project" disabled={!ok || busy} loading={busy} onNext={create} />}
    >
      <div className="ob-f">
        <label className="ob-l" htmlFor="project-name">
          Name
        </label>
        <div className="ob-in">
          <ObIcon name="folder" />
          <input id="project-name" autoFocus autoComplete="off" placeholder="Checkout API" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      </div>
      <div className="ob-f">
        <label className="ob-l" htmlFor="project-slug">
          Address<small>the SDKs send it with every request</small>
        </label>
        <div className={`ob-in${taken ? " bad" : ""}`}>
          <ObIcon name="link" />
          {host ? <span className="pre">{host}/</span> : null}
          <input
            id="project-slug"
            value={address}
            onChange={(e) => pick(slugify(e.target.value))}
            aria-invalid={taken}
            aria-describedby={taken ? "slug-err" : undefined}
          />
          <span className="r" aria-live="polite">
            {mine ? (
              <>
                <ObIcon name="done" />
                Yours
              </>
            ) : status.kind === "available" ? (
              <>
                <ObIcon name="done" />
                Available
              </>
            ) : status.kind === "checking" ? (
              <span style={{ color: "var(--ink-muted)" }}>Checking…</span>
            ) : status.kind === "taken" ? (
              <span style={{ color: "var(--error)" }}>Taken</span>
            ) : null}
          </span>
        </div>
        {status.kind === "taken" ? (
          <p id="slug-err" className="ob-err">
            {status.raced ? "Someone just took that address." : "That address is taken."}{" "}
            {status.suggestions.length > 0 ? (
              <>
                Try{" "}
                {status.suggestions.map((s, i) => (
                  <Fragment key={s}>
                    {i > 0 ? ", " : null}
                    <button type="button" className="cp-link" onClick={() => pick(s)}>
                      {s}
                    </button>
                  </Fragment>
                ))}
                .
              </>
            ) : (
              "Project addresses are unique across APILens. Try adding your team or product."
            )}
          </p>
        ) : null}
      </div>
      <div className="ob-f">
        <label className="ob-l" htmlFor="project-env">
          Environments<small>you can add more later</small>
        </label>
        {/* Clicking anywhere in the field focuses the entry; the chips' remove buttons stay keyboard reachable. */}
        <div className={`ii${envErr ? " bad" : ""}`} onClick={() => envInput.current?.focus()}>
          {envs.length > 0 ? (
            <ul className="ii-chips" aria-label="Environments">
              {envs.map((env) => (
                <li key={env} className="ii-chip">
                  <span className="ii-email">{env}</span>
                  <button
                    type="button"
                    className="ii-x"
                    aria-label={`Remove ${env}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      remove(env);
                    }}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <input
            ref={envInput}
            id="project-env"
            value={draft}
            placeholder={envs.length ? "Add another, e.g. dev" : "production"}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setDraft(e.target.value);
              setEnvErr(null);
            }}
            onKeyDown={onKey}
            aria-invalid={envErr ? true : undefined}
            aria-describedby={describedBy(envErr && "env-err", !envErr && envs.length === 0 && !draft.trim() && "env-none")}
          />
        </div>
        {envErr ? (
          <p id="env-err" className="ob-err">
            {envErr}
          </p>
        ) : envs.length === 0 && !draft.trim() ? (
          <p id="env-none" className="ob-err">
            Add at least one environment.
          </p>
        ) : null}
      </div>
      <div className="ob-note">
        <ObIcon name="info" />
        <span>
          Requests are tagged with the environment the SDK reports, so <b>production</b> and <b>staging</b> stay apart.
        </span>
      </div>
    </ObShell>
  );
}
