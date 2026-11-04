"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { emailStartError, startEmailSignIn } from "@/lib/email-sign-in";
import {
  type RememberedAccount,
  emailInitials,
  forgetAccount,
  readRememberedAccount,
  relativeDay,
} from "@/lib/remembered-account";
import { type SignInMethods, altMethods, gridColumns } from "@/lib/sign-in-methods";
import type { SignInNotice } from "@/lib/sign-in-notice";
import { AltLink } from "./alt-method";
import { ObIcon, ObShell } from "./ob";
import { SignInNoticeBanner } from "./sign-in-notice";

const valid = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e.trim());

/**
 * Returning users: the remembered account first (from `localStorage`, when this device has one),
 * a passkey as the primary action. `methods` (from `GET /auth/providers`) decides which provider
 * buttons sit next to the email code; `next` is where to land after signing in; `notice` (from
 * `?error=`/`?reason=`) sits above the form.
 */
export function SignIn({ methods, next, notice }: { methods: SignInMethods; next?: string; notice?: SignInNotice | null }) {
  const router = useRouter();
  const alts = altMethods(methods, { email: true });
  // Read after mount: the server render (and a blocked store) shows the email field.
  const [remembered, setRemembered] = useState<RememberedAccount | null>(null);
  useEffect(() => setRemembered(readRememberedAccount()), []);
  const [email, setEmail] = useState("");
  const [touched, setTouched] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bad = touched && !valid(email);
  const target = remembered ? remembered.email : email.trim();

  const notYou = () => {
    forgetAccount();
    setRemembered(null);
    setError(null);
  };

  const emailCode = async () => {
    if (sending) return;
    if (!remembered && !valid(email)) return setTouched(true);
    setSending(true);
    setError(null);
    const res = await startEmailSignIn({ email: target, next });
    if (res.ok) return router.push(res.next);
    setSending(false);
    setError(emailStartError(res.code, res.retryAfter));
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
      {notice ? <SignInNoticeBanner notice={notice} /> : null}
      <div className="ob-f">
        {remembered ? (
          <div className="ob-row">
            <span className="cp-av cp-av--sm">{emailInitials(remembered.email)}</span>
            <span className="t">
              <b>{remembered.email}</b>
              <small>Used on this device {relativeDay(remembered.at)}</small>
            </span>
            <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={notYou}>
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
        {error ? (
          <p className="ob-err" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <div style={{ marginTop: 14 }}>
        <Link className="ah-btn ah-btn--primary au-btn-full" href="/platform/incidents">
          <ObIcon name="finger" />
          Continue with a passkey
        </Link>
      </div>
      <div className="ob-or">or</div>
      <div style={{ display: "grid", gridTemplateColumns: gridColumns(alts.length), gap: 10 }}>
        {alts.map((m) =>
          m === "email" ? (
            <button key={m} type="button" className={`ah-btn ah-btn--secondary${sending ? " is-loading" : ""}`} onClick={emailCode} disabled={sending} aria-busy={sending}>
              <ObIcon name="mail" />
              Email code
            </button>
          ) : (
            <AltLink key={m} method={m} href="/platform/incidents" />
          ),
        )}
      </div>
    </ObShell>
  );
}
