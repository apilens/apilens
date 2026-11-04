"use client";

import { unstable_rethrow } from "next/navigation";
import { Fragment, useEffect, useRef, useState, useTransition } from "react";
import { createOrganization } from "@/app/(auth)/onboarding/create/actions";
import type { OnboardingAnswers } from "@/lib/identity";
import { type CreateOrgResult, type SlugStatus, checkableSlug, createOrgError, createSlugChecker, slugify } from "@/lib/org-slug";
import { BackNext, ObIcon, ObShell, type StepProps } from "./ob";
import { useOnboardingContinue, useOnboardingToast } from "./progress";

const FAILED: CreateOrgResult = { ok: false, code: "unknown_error", error: createOrgError("unknown_error") };

/**
 * "Name your organization" (#330). The address is checked as the user types (debounced, the
 * previous check aborted), Create calls `POST /orgs` and continues to the project step with the
 * address saved as `org_slug`. `answers` are the saved onboarding answers (#327): a refresh keeps
 * the address entered. `host` is the public UI host the address is shown under; `owned` the
 * slugs of organizations the user already owns (their own address is not "taken").
 */
export function CreateOrg({
  step = 1,
  reached = step,
  answers = {},
  host = "",
  owned = [],
}: Partial<StepProps> & { answers?: OnboardingAnswers; host?: string; owned?: string[] }) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState(answers.org_slug ?? "");
  const [edited, setEdited] = useState(Boolean(answers.org_slug));
  const [checked, setChecked] = useState<{ slug: string; status: SlugStatus } | null>(null);
  const { go, pending } = useOnboardingContinue(reached);
  const [creating, startCreating] = useTransition();
  const toast = useOnboardingToast();
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
  const busy = pending || creating;
  const ok = name.trim().length > 1 && checkableSlug(address) && (mine || status.kind === "available" || status.kind === "unknown");

  const pick = (s: string) => {
    setEdited(true);
    setSlug(s);
  };

  const create = () =>
    startCreating(async () => {
      const target = address;
      const res = await createOrganization(name, target).catch((err: unknown) => {
        unstable_rethrow(err);
        return FAILED;
      });
      if (res.ok) {
        go("project", "/onboarding/project", { org_slug: res.slug });
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
      eyebrow="02:24 AM"
      headline={["It’s not about who.", "It’s about what."]}
      body="Clear evidence makes it easier to stay kind at 2 a.m."
      receipt={
        <>
          cause · <b>v2.8.1</b> · one config change
        </>
      }
      progress={33.33}
      step={step}
      reached={reached}
      badge="building"
      title="Name your organization"
      lead="Usually your company. It holds projects, people and billing."
      footer={<BackNext back="/onboarding/join" nextLabel="Create organization" disabled={!ok || busy} loading={busy} onNext={create} />}
    >
      <div className="ob-f">
        <label className="ob-l" htmlFor="org-name">
          Name
        </label>
        <div className="ob-in">
          <ObIcon name="building" />
          <input id="org-name" autoFocus autoComplete="organization" placeholder="Motadata" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      </div>
      <div className="ob-f">
        <label className="ob-l" htmlFor="org-slug">
          Address<small>used in links and the CLI</small>
        </label>
        <div className={`ob-in${taken ? " bad" : ""}`}>
          <ObIcon name="link" />
          {host ? <span className="pre">{host}/</span> : null}
          <input id="org-slug" value={address} onChange={(e) => pick(slugify(e.target.value))} aria-invalid={taken} aria-describedby={taken ? "slug-err" : undefined} />
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
              "Try adding your region or team."
            )}
          </p>
        ) : null}
      </div>
      <div className="ob-note">
        <ObIcon name="team" />
        <span>Anyone you invite later joins this organization. You can rename it anytime.</span>
      </div>
    </ObShell>
  );
}
