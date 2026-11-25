"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { createProject } from "@/app/org/[org]/projects/new/actions";
import {
  PROJECT_SLUG_CHECK_PATH,
  type SlugStatus,
  checkableSlug,
  createSlugChecker,
  slugify,
} from "@/lib/org-slug";
import { DEFAULT_ENVIRONMENTS, type CreateProjectResult, addEnvironments, createProjectError, envError } from "@/lib/project-create";
import { sdkSetupPath } from "@/lib/landing";
import { newProjectHref } from "@/lib/routes";
import { ObIcon } from "../onboarding/ob";
import { PageHeader } from "../page-header";
import "../org-settings/org-settings.css";
import "./org.css";

const FAILED: CreateProjectResult = { ok: false, code: "unknown_error", error: createProjectError("unknown_error") };

/**
 * `/org/<org>/projects/new`: create a project after onboarding. The address is checked as the
 * user types against the organization's projects, and Create calls `POST /orgs/{org}/projects`
 * then opens the new project on its SDK setup (it has no data yet). `orgs` are the organizations
 * the user may create a project in; picking another one moves to its own page.
 */
export function NewProject({ org, orgs }: { org: string; orgs: readonly { slug: string; name: string }[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [edited, setEdited] = useState(false);
  const [envs, setEnvs] = useState<string[]>(DEFAULT_ENVIRONMENTS);
  const [envText, setEnvText] = useState("");
  const [envProblem, setEnvProblem] = useState<string | null>(null);
  const [checked, setChecked] = useState<{ slug: string; status: SlugStatus } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [creating, startCreating] = useTransition();
  const address = edited ? slug : slugify(name);

  const checker = useRef<ReturnType<typeof createSlugChecker> | null>(null);
  useEffect(() => {
    const c = createSlugChecker({ onResult: (s, status) => setChecked({ slug: s, status }), path: PROJECT_SLUG_CHECK_PATH });
    checker.current = c;
    return () => c.cancel();
  }, []);
  useEffect(() => {
    checker.current?.check(address);
  }, [address]);

  const status: SlugStatus = checked?.slug === address ? checked.status : checkableSlug(address) ? { kind: "checking" } : { kind: "idle" };
  const taken = status.kind === "taken";
  const ok =
    name.trim().length > 1 && checkableSlug(address) && envs.length > 0 && (status.kind === "available" || status.kind === "unknown");

  const addEnv = () => {
    const res = addEnvironments(envs, envText);
    setEnvs(res.envs);
    setEnvProblem(res.error ? envError(res.error, res.rejected ?? envText) : null);
    if (!res.error) setEnvText("");
  };

  const create = () =>
    startCreating(async () => {
      const target = address;
      setProblem(null);
      const res = await createProject(org, name, target, envs).catch(() => FAILED);
      if (res.ok) {
        // A new project has no data: open its SDK setup, as landing does.
        router.push(sdkSetupPath(res.slug));
        return;
      }
      if ("suggestions" in res) {
        setChecked({ slug: target, status: { kind: "taken", suggestions: res.suggestions, raced: true } });
        return;
      }
      setProblem(res.error);
    });

  return (
    <div className="page os org-page org-page--form">
      <PageHeader title="Create a project" lead="One project per API or service, with its own keys, environments and access." />
      <form
        className="os-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok && !creating) create();
        }}
        noValidate
      >
        <div className="os-card__body">
          {orgs.length > 1 ? (
            <div className="ob-f">
              <label className="ob-l" htmlFor="new-project-org">
                Organization
              </label>
              <select
                className="ob-in"
                id="new-project-org"
                value={org}
                onChange={(e) => {
                  if (e.target.value !== org) router.push(newProjectHref(e.target.value));
                }}
              >
                {orgs.map((o) => (
                  <option key={o.slug} value={o.slug}>
                    {o.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="ob-f">
            <label className="ob-l" htmlFor="new-project-name">
              Project name
            </label>
            <div className="ob-in">
              <ObIcon name="folder" />
              <input
                id="new-project-name"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="payments-service"
                maxLength={100}
                aria-describedby="new-project-address"
              />
            </div>
          </div>
          <div className="ob-f">
            <label className="ob-l" htmlFor="new-project-slug">
              Address
            </label>
            <div className={`ob-in${taken ? " bad" : ""}`}>
              <ObIcon name="link" />
              <input
                id="new-project-slug"
                value={address}
                onChange={(e) => {
                  setEdited(true);
                  setSlug(slugify(e.target.value));
                }}
                aria-invalid={taken}
                aria-describedby="new-project-address"
              />
            </div>
            <p id="new-project-address" className="org-hint">
              /project/<b>{address || "your-project"}</b>
              {status.kind === "available" ? " · available" : null}
              {taken ? " · taken" : null}
            </p>
            {taken && status.suggestions.length > 0 ? (
              <p className="org-hint">
                Free:{" "}
                {status.suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="cp-link"
                    onClick={() => {
                      setEdited(true);
                      setSlug(s);
                    }}
                  >
                    {s}
                  </button>
                ))}
              </p>
            ) : null}
          </div>
          <div className="ob-f">
            <span className="ob-l" id="new-project-envs-label">
              Environments
            </span>
            <ul className="org-envs" aria-labelledby="new-project-envs-label">
              {envs.map((env) => (
                <li key={env} className="org-env">
                  {env}
                  <button type="button" className="cp-link" onClick={() => setEnvs(envs.filter((e) => e !== env))} aria-label={`Remove ${env}`}>
                    ×
                  </button>
                </li>
              ))}
            </ul>
            <div className="ob-in">
              <ObIcon name="next" />
              <input
                id="new-project-env"
                value={envText}
                onChange={(e) => setEnvText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addEnv();
                  }
                }}
                placeholder="Add an environment"
                aria-label="Add an environment"
              />
            </div>
            {envProblem ? <p className="ob-err">{envProblem}</p> : null}
            {envs.length === 0 ? <p className="org-hint">Add at least one environment, such as production.</p> : null}
          </div>
          {problem ? (
            <p className="ob-err" role="alert">
              {problem}
            </p>
          ) : null}
        </div>
        <div className="os-card__foot">
          <Link className="ah-btn ah-btn--ghost ah-btn--sm" href={`/org/${org}`}>
            Cancel
          </Link>
          <button
            type="submit"
            className={`ah-btn ah-btn--primary ah-btn--sm${creating ? " is-loading" : ""}`}
            disabled={!ok || creating}
            aria-busy={creating || undefined}
          >
            Create project
          </button>
        </div>
      </form>
    </div>
  );
}
