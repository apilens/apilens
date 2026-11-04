"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Brand, ObIcon, ObShell } from "./ob";

const REMEMBERED = "amit@motadata.com";
const valid = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e.trim());

/** Returning users: the remembered account first, a passkey as the primary action. */
export function SignIn() {
  const router = useRouter();
  const [remembered, setRemembered] = useState(true);
  const [email, setEmail] = useState("");
  const [touched, setTouched] = useState(false);
  const bad = touched && !valid(email);
  const target = remembered ? REMEMBERED : email.trim();

  const emailCode = () => {
    if (!remembered && !valid(email)) return setTouched(true);
    router.push(`/verify?flow=signin&email=${encodeURIComponent(target)}`);
  };

  return (
    <ObShell
      eyebrow="Incident #2041"
      headline={["Welcome back.", "We hope you", "slept well."]}
      body="Last night’s issue was found, fixed and explained before morning."
      receipt={
        <>
          <b>resolved</b> · 27 min · PR #318 merged
        </>
      }
      badge="lock"
      title="Welcome back"
      lead="Sign in to APILens."
      below={
        <>
          New to APILens? <Link className="cp-link" href="/sign-up">Create an account</Link>
        </>
      }
    >
      <div className="ob-f">
        {remembered ? (
          <div className="ob-row">
            <span className="cp-av cp-av--sm">AM</span>
            <span className="t">
              <b>{REMEMBERED}</b>
              <small>Used on this device 3 days ago</small>
            </span>
            <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={() => setRemembered(false)}>
              Not you?
            </button>
          </div>
        ) : (
          <>
            <label className="ob-l" htmlFor="si-email">
              Work email
            </label>
            <div className={`ob-in${bad ? " bad" : ""}`}>
              <ObIcon name="mail" />
              <input id="si-email" type="email" autoComplete="email webauthn" autoFocus placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} onBlur={() => setTouched(true)} onKeyDown={(e) => e.key === "Enter" && emailCode()} aria-invalid={bad} aria-describedby={bad ? "si-err" : undefined} />
            </div>
            {bad ? (
              <p id="si-err" className="ob-err">
                Enter a work email like you@company.com.
              </p>
            ) : null}
          </>
        )}
      </div>
      <div style={{ marginTop: 14 }}>
        <Link className="ah-btn ah-btn--primary au-btn-full" href="/platform/incidents">
          <ObIcon name="finger" />
          Continue with a passkey
        </Link>
      </div>
      <div className="ob-or">or</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
        <button type="button" className="ah-btn ah-btn--secondary" onClick={emailCode}>
          <ObIcon name="mail" />
          Email code
        </button>
        <Link className="ah-btn ah-btn--secondary" href="/platform/incidents">
          <Brand src="github" label="github" />
          GitHub
        </Link>
        <Link className="ah-btn ah-btn--secondary" href="/platform/incidents">
          <Brand src="google" label="google" />
          Google
        </Link>
      </div>
    </ObShell>
  );
}
