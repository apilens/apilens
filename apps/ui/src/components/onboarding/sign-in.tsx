"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  PASSKEY_CANCELLED,
  type PasskeyResult,
  conditionalMediationAvailable,
  passkeyError,
  passkeysSupported,
  signInWithPasskey,
} from "@/lib/auth/passkeys";
import { emailStartError, startEmailSignIn } from "@/lib/email-sign-in";
import {
  type RememberedAccount,
  emailInitials,
  forgetAccount,
  readRememberedAccount,
  relativeDay,
} from "@/lib/remembered-account";
import { type OAuthLinks, type SignInMethods, altMethods, gridColumns } from "@/lib/sign-in-methods";
import type { SignInNotice } from "@/lib/sign-in-notice";
import { AltLink } from "./alt-method";
import { ObIcon, ObShell } from "./ob";
import { SignInNoticeBanner } from "./sign-in-notice";

const valid = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e.trim());

/**
 * Returning users: the remembered account first (from `localStorage`, when this device has one),
 * a passkey as the primary action: the button, plus passkeys in the email field's autofill while
 * the field is shown (cancelled when another method is picked; leaving the page cancels it too).
 * Both are hidden when the browser has no WebAuthn. `methods` (from `GET /auth/providers`) decides
 * which provider buttons sit next to the email code; `oauth` holds the Google/GitHub start URLs
 * (built on the server); `next` is where to land after signing in; `notice` (from
 * `?error=`/`?reason=`) sits above the form.
 */
export function SignIn({
  methods,
  oauth,
  next,
  notice,
}: {
  methods: SignInMethods;
  oauth?: OAuthLinks;
  next?: string;
  notice?: SignInNotice | null;
}) {
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
  // Passkeys: shown until the browser proves it has no WebAuthn (most do, so no layout shift).
  const [passkeys, setPasskeys] = useState(true);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  // The pending conditional (autofill) request; aborted when the user picks another method.
  const autofill = useRef<AbortController | null>(null);
  const [autofillRound, setAutofillRound] = useState(0);
  const stopAutofill = () => {
    autofill.current?.abort();
    autofill.current = null;
  };

  const passkeyDone = (res: PasskeyResult) => {
    if (res.ok) {
      router.push(res.next);
      return true;
    }
    setError(passkeyError(res.code));
    return false;
  };

  // Offer passkeys in the email field's autofill while the field is on screen.
  useEffect(() => {
    if (!passkeysSupported()) {
      setPasskeys(false);
      return;
    }
    if (remembered) return;
    const ctl = new AbortController();
    autofill.current = ctl;
    void (async () => {
      if (!(await conditionalMediationAvailable()) || ctl.signal.aborted) return;
      const res = await signInWithPasskey({ mediation: "conditional", signal: ctl.signal, next });
      if (ctl.signal.aborted || (!res.ok && res.code === PASSKEY_CANCELLED)) return;
      // A failed pick (e.g. an unknown passkey) shows its error and offers autofill again.
      if (!passkeyDone(res)) setAutofillRound((n) => n + 1);
    })();
    return () => ctl.abort();
    // passkeyDone only closes over setters and the router, so it is not a dependency.
  }, [remembered, next, autofillRound]);

  const passkey = async () => {
    if (passkeyBusy) return;
    stopAutofill();
    setPasskeyBusy(true);
    setError(null);
    const hint = remembered ? remembered.email : valid(email) ? email.trim() : undefined;
    const res = await signInWithPasskey({ mediation: "optional", email: hint, next });
    if (passkeyDone(res)) return;
    setPasskeyBusy(false);
    setAutofillRound((n) => n + 1);
  };

  const notYou = () => {
    forgetAccount();
    setRemembered(null);
    setError(null);
  };

  const emailCode = async () => {
    if (sending) return;
    if (!remembered && !valid(email)) return setTouched(true);
    stopAutofill();
    setSending(true);
    setError(null);
    const res = await startEmailSignIn({ email: target, next });
    if (res.ok) return router.push(res.next);
    setSending(false);
    setError(emailStartError(res.code, res.retryAfter));
    setAutofillRound((n) => n + 1);
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
      {passkeys ? (
        <>
          <div style={{ marginTop: 14 }}>
            <button type="button" className={`ah-btn ah-btn--primary au-btn-full${passkeyBusy ? " is-loading" : ""}`} onClick={passkey} disabled={passkeyBusy} aria-busy={passkeyBusy}>
              <ObIcon name="finger" />
              Continue with a passkey
            </button>
          </div>
          <div className="ob-or">or</div>
        </>
      ) : null}
      <div style={{ display: "grid", gridTemplateColumns: gridColumns(alts.length), gap: 10, marginTop: passkeys ? undefined : 14 }}>
        {alts.map((m) =>
          m === "email" ? (
            <button key={m} type="button" className={`ah-btn ah-btn--secondary${sending ? " is-loading" : ""}`} onClick={emailCode} disabled={sending} aria-busy={sending}>
              <ObIcon name="mail" />
              Email code
            </button>
          ) : (
            <AltLink key={m} method={m} href={m === "sso" ? "/platform/incidents" : (oauth?.[m] ?? "/sign-in")} />
          ),
        )}
      </div>
    </ObShell>
  );
}
