"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { createOrganization } from "@/app/organizations/new/actions";
import { type CreateOrgResult, type SlugStatus, checkableSlug, createOrgError, createSlugChecker, slugify } from "@/lib/org-slug";
import { orgHref } from "@/lib/routes";
import { ObIcon } from "../onboarding/ob";
import { PageHeader } from "../page-header";
import "../org-settings/org-settings.css";
import "./org.css";

const FAILED: CreateOrgResult = { ok: false, code: "unknown_error", error: createOrgError("unknown_error") };

/**
 * `/organizations/new`: create an organization after onboarding. The address is checked as the
 * user types (debounced, the previous check aborted) and Create calls `POST /orgs`, then opens the
 * new organization, which offers its first project. `owned` are the slugs the user already owns,
 * so their own organization never reads as taken.
 */
export function NewOrg({ host = "", owned = [] }: { host?: string; owned?: string[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [edited, setEdited] = useState(false);
  const [checked, setChecked] = useState<{ slug: string; status: SlugStatus } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [creating, startCreating] = useTransition();
  const address = edited ? slug : slugify(name);
  const mine = owned.includes(address);

  const checker = useRef<ReturnType<typeof createSlugChecker> | null>(null);
  useEffect(() => {
    const c = createSlugChecker({ onResult: (s, status) => setChecked({ slug: s, status }) });
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
  const ok = name.trim().length > 1 && checkableSlug(address) && (mine || status.kind === "available" || status.kind === "unknown");

  const create = () =>
    startCreating(async () => {
      const target = address;
      setProblem(null);
      const res = await createOrganization(name, target).catch(() => FAILED);
      if (res.ok) {
        router.push(orgHref(res.slug));
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
      <PageHeader title="Create an organization" lead="For a separate team or company. You will be its owner." />
      <form
        className="os-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok && !creating) create();
        }}
        noValidate
      >
        <div className="os-card__body">
          <div className="ob-f">
            <label className="ob-l" htmlFor="new-org-name">
              Organization name
            </label>
            <div className="ob-in">
              <ObIcon name="building" />
              <input
                id="new-org-name"
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Acme"
                maxLength={100}
                aria-describedby="new-org-address"
              />
            </div>
          </div>
          <div className="ob-f">
            <label className="ob-l" htmlFor="new-org-slug">
              Address
            </label>
            <div className={`ob-in${taken ? " bad" : ""}`}>
              <ObIcon name="link" />
              <input
                id="new-org-slug"
                value={address}
                onChange={(e) => {
                  setEdited(true);
                  setSlug(slugify(e.target.value));
                }}
                aria-invalid={taken}
                aria-describedby="new-org-address"
              />
            </div>
            <p id="new-org-address" className="org-hint">
            {host ? `${host}/org/` : "/org/"}
            <b>{address || "your-organization"}</b>
            {mine ? " · you already own this one" : null}
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
          {problem ? (
            <p className="ob-err" role="alert">
              {problem}
            </p>
          ) : null}
        </div>
        <div className="os-card__foot">
          <Link className="ah-btn ah-btn--ghost ah-btn--sm" href="/organizations">
            Cancel
          </Link>
          <button
            type="submit"
            className={`ah-btn ah-btn--primary ah-btn--sm${creating ? " is-loading" : ""}`}
            disabled={!ok || creating}
            aria-busy={creating || undefined}
          >
            Create organization
          </button>
        </div>
      </form>
    </div>
  );
}
