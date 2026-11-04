"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { LINKS, extLink } from "@/lib/links";
import { Brand, ObIcon, ObShell } from "./ob";

const valid = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e.trim());

export function SignUp() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [touched, setTouched] = useState(false);
  const bad = touched && !valid(email);

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    setTouched(true);
    if (valid(email)) router.push(`/verify?flow=signup&email=${encodeURIComponent(email.trim())}`);
  };

  return (
    <ObShell
      eyebrow="02:14 AM"
      headline={["Something’s wrong.", "Everything", "looks fine."]}
      body="Your phone is buzzing, the dashboards are green, and you’re not sure where to start."
      receipt={
        <>
          alert · error rate <b>31%</b>
        </>
      }
      progress={0}
      step={0}
      badge="user"
      title="Create your APILens account"
      lead="Free for 3 services. No card needed."
      below={
        <>
          Already have an account? <Link className="cp-link" href="/sign-in">Sign in</Link> · <a className="cp-link" {...extLink(LINKS.terms)}>Terms</a> · <a className="cp-link" {...extLink(LINKS.privacy)}>Privacy</a>
        </>
      }
    >
      <form onSubmit={submit} noValidate>
        <div className="ob-f">
          <label className="ob-l" htmlFor="su-email">
            Work email
          </label>
          <div className={`ob-in${bad ? " bad" : ""}`}>
            <ObIcon name="mail" />
            <input id="su-email" type="email" autoComplete="email" autoFocus placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} onBlur={() => email && setTouched(true)} aria-invalid={bad} aria-describedby={bad ? "su-err" : undefined} />
          </div>
          {bad ? (
            <p id="su-err" className="ob-err">
              Enter a work email like you@company.com.
            </p>
          ) : null}
        </div>
        <div className="ob-note">
          <ObIcon name="info" />
          <span>We’ll email you a 6-digit code. There’s no password to remember.</span>
        </div>
        <div style={{ marginTop: 22 }}>
          <button type="submit" className="ah-btn ah-btn--primary au-btn-full">
            Continue
            <ObIcon name="next" />
          </button>
        </div>
      </form>
      <div className="ob-or">or</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Link className="ah-btn ah-btn--secondary" href="/onboarding/about">
          <Brand src="github" label="github" />
          GitHub
        </Link>
        <Link className="ah-btn ah-btn--secondary" href="/onboarding/about">
          <Brand src="google" label="google" />
          Google
        </Link>
      </div>
    </ObShell>
  );
}
