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
import { SIGN_IN_NOTICES, type SignInNotice } from "@/lib/sign-in-notice";
import { ssoRequiredMatch } from "@/lib/sso";
import { AltLink } from "./alt-method";
import { ObIcon, ObShell } from "./ob";
import { SignInNoticeBanner } from "./sign-in-notice";
import { SSOButton, SSOLink, useSSOLookup } from "./sso";

const valid = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e.trim());

/**
 * Returning users: the remembered account first (from `localStorage`, when this device has one),
 * a passkey as the primary action: the button, plus passkeys in the email field's autofill while
 * the field is shown (cancelled when another method is picked; leaving the page cancels it too).
 * Both are hidden when the browser has no WebAuthn. `methods` (from `GET /auth/providers`) decides
 * which provider buttons sit next to the email code; `oauth` holds the Google/GitHub start URLs
 * (built on the server); `next` is where to land after signing in; `notice` (from
 * `?error=`/`?reason=`) sits above the form.
 *
 * SSO (#323): once the email is valid its domain is looked up. An organization that enforces SSO
 * replaces the email code with "Continue with <org> SSO" as the primary action (the passkey
 * button stays, as a secondary one); SSO that is offered but not enforced adds that button under
 * the others. The email code checks the lookup before sending, and a `sso_required` refusal shows
 * the organization's SSO the same way.
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
  const sso = useSSOLookup(remembered ? remembered.email : valid(email) ? email.trim() : null, next);
  const enforced = sso.match?.enforced === true;
  const [ssoBusy, setSsoBusy] = useState(false);
  const [ssoNotice, setSsoNotice] = useState(false);
  // An enforced organization takes the email code's place; its own SSO button replaces the generic one.
  const shown = alts.filter((m) => !(m === "email" && enforced) && !(m === "sso" && sso.match));
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
    // An enforced domain never gets a code: go to its SSO instead (the lookup may still be pending).
    const found = await sso.resolve(target);
    if (found.kind === "match" && found.match.enforced) {
      window.location.assign(found.match.startUrl);
      return;
    }
    const res = await startEmailSignIn({ email: target, next });
    if (res.ok) return router.push(res.next);
    setSending(false);
    const required = res.code === "sso_required" ? ssoRequiredMatch(res.startUrl) : null;
    if (required) {
      sso.remember(target, required);
      setSsoNotice(true);
    } else {
      setError(emailStartError(res.code, res.retryAfter));
    }
    setAutofillRound((n) => n + 1);
  };

  const genericSSO = async () => {
    if (ssoBusy) return;
    // The passkey autofill stays on: a lookup does not compete with it, and leaving the page ends it.
    setSsoBusy(true);
    setError(null);
    const problem = await sso.go(remembered ? remembered.email : valid(email) ? email.trim() : null);
    if (problem === null) return; // navigating to the identity provider
    setSsoBusy(false);
    if (!remembered && !valid(email)) setTouched(true);
    setError(problem);
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
      {ssoNotice ? (
        <SignInNoticeBanner key="sso_required" notice={{ code: "sso_required", ...SIGN_IN_NOTICES.sso_required }} />
      ) : notice ? (
        <SignInNoticeBanner notice={notice} />
      ) : null}
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
              <input id="si-email" type="email" autoComplete="email webauthn" autoFocus placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} onBlur={() => setTouched(true)} onKeyDown={(e) => e.key === "Enter" && (enforced && sso.match ? window.location.assign(sso.match.startUrl) : emailCode())} aria-invalid={bad} aria-describedby={bad ? "si-err" : undefined} />
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
      {enforced && sso.match ? (
        <div style={{ marginTop: 14 }}>
          <SSOLink match={sso.match} primary />
        </div>
      ) : null}
      {passkeys ? (
        <>
          <div style={{ marginTop: enforced ? 10 : 14 }}>
            <button type="button" className={`ah-btn ${enforced ? "ah-btn--secondary" : "ah-btn--primary"} au-btn-full${passkeyBusy ? " is-loading" : ""}`} onClick={passkey} disabled={passkeyBusy} aria-busy={passkeyBusy}>
              <ObIcon name="finger" />
              Continue with a passkey
            </button>
          </div>
          {shown.length > 0 ? <div className="ob-or">or</div> : null}
        </>
      ) : enforced && shown.length > 0 ? (
        <div className="ob-or">or</div>
      ) : null}
      {shown.length > 0 ? (
        <div style={{ display: "grid", gridTemplateColumns: gridColumns(shown.length), gap: 10, marginTop: passkeys || enforced ? undefined : 14 }}>
          {shown.map((m) =>
            m === "email" ? (
              <button key={m} type="button" className={`ah-btn ah-btn--secondary${sending ? " is-loading" : ""}`} onClick={emailCode} disabled={sending} aria-busy={sending}>
                <ObIcon name="mail" />
                Email code
              </button>
            ) : m === "sso" ? (
              <SSOButton key={m} busy={ssoBusy} onClick={genericSSO} />
            ) : (
              <AltLink key={m} method={m} href={oauth?.[m] ?? "/sign-in"} />
            ),
          )}
        </div>
      ) : null}
      {sso.match && !enforced ? (
        <div style={{ marginTop: 10 }}>
          <SSOLink match={sso.match} />
        </div>
      ) : null}
    </ObShell>
  );
}
