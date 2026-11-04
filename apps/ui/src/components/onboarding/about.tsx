"use client";

import { useState, useTransition } from "react";
import { finishInvitedOnboarding } from "@/app/(auth)/onboarding/actions";
import { BackNext, ObShell, type StepProps } from "./ob";
import { useOnboardingContinue } from "./progress";

const PICKS = [
  { id: "endpoints", t: "Slow or failing endpoints", s: "Every API, with its latency and error rate" },
  { id: "requests", t: "Requests across services", s: "One request, followed through every service" },
  { id: "exceptions", t: "Exceptions", s: "Grouped, with the request that caused each one" },
];

/**
 * `invitedOrg`: the organization an invitation made the user a member of (#337). They skip the
 * organization and project steps: Continue finishes onboarding and opens its first project.
 */
export function About({ step = 0, reached = step, invitedOrg }: Partial<StepProps> & { invitedOrg?: string }) {
  const [pick, setPick] = useState("endpoints");
  const { go, pending } = useOnboardingContinue(reached);
  const [finishing, startFinishing] = useTransition();
  return (
    <ObShell
      eyebrow="02:21 AM"
      headline={["It usually starts", "with a small change."]}
      body="We look for the release that landed just before the first error, so you don’t have to."
      receipt={
        <>
          first error · <b>9 min</b> after <b>v2.8.1</b>
        </>
      }
      progress={23.33}
      step={step}
      reached={reached}
      badge="eye"
      title="What should you see first?"
      lead="This becomes your home screen. You can change it anytime."
      footer={
        invitedOrg ? (
          <BackNext back="/verify" nextLabel={`Continue to ${invitedOrg}`} loading={finishing} disabled={finishing} onNext={() => startFinishing(() => finishInvitedOnboarding())} />
        ) : (
          <BackNext back="/verify" nextLabel="Continue" loading={pending} onNext={() => go("join", "/onboarding/join")} />
        )
      }
    >
      <div className="ob-picks" role="radiogroup" aria-label="Home screen">
        {PICKS.map((p) => (
          <button key={p.id} type="button" role="radio" aria-checked={pick === p.id} className={`ob-pick${pick === p.id ? " on" : ""}`} onClick={() => setPick(p.id)}>
            <span className="rd" />
            <span className="tx">
              <b>{p.t}</b>
              <small>{p.s}</small>
            </span>
          </button>
        ))}
      </div>
    </ObShell>
  );
}
