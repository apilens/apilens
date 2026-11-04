"use client";

import { useState } from "react";
import { BackNext, ObShell } from "./ob";

const PICKS = [
  { id: "endpoints", t: "Slow or failing endpoints", s: "Every API, with its latency and error rate" },
  { id: "requests", t: "Requests across services", s: "One request, followed through every service" },
  { id: "exceptions", t: "Exceptions", s: "Grouped, with the request that caused each one" },
];

export function About() {
  const [pick, setPick] = useState("endpoints");
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
      step={0}
      badge="eye"
      title="What should you see first?"
      lead="This becomes your home screen. You can change it anytime."
      footer={<BackNext back="/verify" next="/onboarding/join" nextLabel="Continue" />}
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
