"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  type PasskeyResult,
  conditionalMediationAvailable,
  passkeyError,
  passkeysSupported,
  signInWithPasskey,
} from "@/lib/auth/passkeys";
import { NETWORK_MESSAGE, errorMessage, rateLimitMessage, startEmail } from "@/lib/email-start";
import { suggestEmail } from "@/lib/email-typo";
import {
  type RememberedAccount,
  emailInitials,
  forgetAccount,
  readRememberedAccount,
  relativeDay,
  rememberAccount,
} from "@/lib/remembered-account";
import { type OAuthLinks, type SignInMethods, altMethods, gridColumns } from "@/lib/sign-in-methods";
import { SIGN_IN_NOTICES, type SignInNotice } from "@/lib/sign-in-notice";
import { type SignInMethod, clearPending, forgetSignIn, lastSignIn, markPending, rememberSignIn } from "@/lib/last-signin";
import { pathWithRemember, withRemember } from "@/lib/keep-signed-in";
import { ssoRequiredMatch } from "@/lib/sso";
import { AltLink } from "./alt-method";
import { ObIcon, ObShell, describedBy } from "./ob";
import { SignInNoticeBanner } from "./sign-in-notice";
import { KeepSignedIn } from "./keep-signed-in";
import { SSOButton, SSOLink, useSSOLookup } from "./sso";

const valid = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e.trim());
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The address typed before Continue, so Back from `/verify` returns to it (this tab only). */
const DRAFT_KEY = "apilens.sign-in-email";
function readDraft(): string {
  try {
    return window.sessionStorage.getItem(DRAFT_KEY) ?? "";
  } catch {
    return "";
  }
}
function writeDraft(email: string) {
  try {
    window.sessionStorage.setItem(DRAFT_KEY, email);
  } catch {
    // Blocked storage: Back just shows an empty field.
  }
}

const METHOD_WORDS: Record<SignInMethod, string> = {
  email: "an email code",
  google: "Google",
  github: "GitHub",
  sso: "single sign-on",
  passkey: "a passkey",
};

/** Shown when the passkey Continue opened did not sign the user in; Continue now sends a code. */
const PASSKEY_FALLBACK = "Your passkey didn’t sign you in. Continue to get a code by email instead.";

/**
 * Identifier first: one email field and one Continue, and APILens picks the way in.
 *
 *   1. A domain whose organization enforces SSO goes to that SSO (Continue becomes its link once
 *      the lookup answers, and Continue checks the lookup again before anything else).
 *   2. An account this device last signed in to with a passkey gets the passkey prompt. If it
 *      does not sign them in, Continue falls back to the email code.
 *   3. Everyone else gets a 6-digit code by email. The answer is the same whether or not the
 *      account exists, so Continue never tells anyone which addresses have accounts or passkeys.
 *
 * Passkeys are also offered in the email field's autofill (conditional mediation) while the
 * field is shown, and as a secondary "Passkey" button for a passkey this device does not know
 * about (a phone, a security key). `methods` (`GET /auth/providers`) adds Google, GitHub and the
 * generic SSO under "or"; `oauth` holds their start URLs (built on the server). `next` is where
 * to land; `notice` (from `?error=`/`?reason=`) sits above the form.
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
  // Read after mount: the server render (and a blocked store) shows the email field.
  const [remembered, setRemembered] = useState<RememberedAccount | null>(null);
  // False until the device has been read: the autofill request waits, so a remembered account
  // never starts (and at once cancels) one.
  const [deviceRead, setDeviceRead] = useState(false);
  const [email, setEmail] = useState("");
  const [last, setLast] = useState<ReturnType<typeof lastSignIn>>(null);
  useEffect(() => {
    // Landing here means any earlier sign-in ended (finished, failed or abandoned).
    clearPending();
    setLast(lastSignIn());
    const account = readRememberedAccount();
    setRemembered(account);
    if (!account) setEmail((typed) => typed || readDraft());
    setDeviceRead(true);
  }, []);
  const [touched, setTouched] = useState(false);
  const [remember, setRemember] = useState(true);
  // Read by the autofill request, which starts before the box can change.
  const rememberRef = useRef(remember);
  rememberRef.current = remember;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limitedUntil, setLimitedUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [dismissedTypo, setDismissedTypo] = useState<string | null>(null);
  const bad = touched && !remembered && !valid(email);
  // The address every method acts on: the remembered account, else the typed one once it is valid.
  const address = remembered ? remembered.email : valid(email) ? email.trim() : null;
  const sso = useSSOLookup(address, next);
  const enforced = sso.match?.enforced === true;
  const [ssoBusy, setSsoBusy] = useState(false);
  const [ssoNotice, setSsoNotice] = useState(false);
  // Passkeys: assumed until the browser proves it has no WebAuthn (most do, so no layout shift).
  const [passkeys, setPasskeys] = useState(true);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  // Set once a passkey attempt the user made did not sign them in: Continue then sends a code.
  const [passkeyFailed, setPasskeyFailed] = useState(false);
  const emailInput = useRef<HTMLInputElement | null>(null);
  const continueButton = useRef<HTMLButtonElement | null>(null);
  // Focus moves after the re-render that shows (and re-enables) its target.
  const focusEmail = useRef(false);
  const focusContinue = useRef(false);
  // The pending conditional (autofill) request; aborted before any other method starts.
  const autofill = useRef<AbortController | null>(null);
  const [autofillRound, setAutofillRound] = useState(0);
  const stopAutofill = () => {
    autofill.current?.abort();
    autofill.current = null;
  };

  // Continue's passkey step: only for the account this device last signed in to with one.
  const passkeyFirst = passkeys && !passkeyFailed && remembered?.method === "passkey";
  const typo = !remembered && valid(email) ? suggestEmail(email) : null;
  const showTypo = typo !== null && typo !== dismissedTypo && !same(typo, email);

  const waitLeft = limitedUntil ? Math.ceil((limitedUntil - now) / 1000) : 0;
  const limited = limitedUntil !== null && waitLeft > 0;
  useEffect(() => {
    if (limitedUntil === null) return;
    if (waitLeft <= 0) {
      setLimitedUntil(null);
      setError(null);
      return;
    }
    const t = setTimeout(() => setNow(Date.now()), 1000);
    return () => clearTimeout(t);
  }, [limitedUntil, waitLeft]);

  const signedIn = (res: Extract<PasskeyResult, { ok: true }>, fallbackEmail?: string) => {
    const who = res.email ?? fallbackEmail;
    if (who) {
      rememberAccount(who, "passkey");
      rememberSignIn("passkey", who);
    }
    router.push(res.next);
  };

  // Offer passkeys in the email field's autofill while the field is on screen.
  useEffect(() => {
    if (!passkeysSupported()) {
      setPasskeys(false);
      return;
    }
    if (!deviceRead || remembered) return;
    const ctl = new AbortController();
    autofill.current = ctl;
    void (async () => {
      if (!(await conditionalMediationAvailable()) || ctl.signal.aborted) return;
      const res = await signInWithPasskey({ mediation: "conditional", signal: ctl.signal, next, remember: () => rememberRef.current });
      if (ctl.signal.aborted) return;
      if (res.ok) return signedIn(res);
      // Only a passkey the user picked from the autofill (unknown, or it failed) says anything and
      // is offered again. Any other failure (most likely the options call: offline, rate limited)
      // is no news to someone who has not done anything yet, Continue works without it, and
      // re-arming at once would just repeat it; the next failed Continue offers autofill again.
      if (res.code === "passkey_unknown" || res.code === "passkey_failed") {
        setError(passkeyError(res.code));
        setPasskeyFailed(true);
        setAutofillRound((n) => n + 1);
      }
    })();
    return () => ctl.abort();
    // signedIn only closes over the router, so it is not a dependency.
  }, [deviceRead, remembered, next, autofillRound]);

  // "Not you?" puts the cursor back in the (now empty) field; a passkey that did not sign in
  // puts it on Continue, which now sends the code.
  useEffect(() => {
    if (!remembered && focusEmail.current) {
      focusEmail.current = false;
      emailInput.current?.focus();
    }
  }, [remembered]);
  useEffect(() => {
    if (!busy && focusContinue.current) {
      focusContinue.current = false;
      continueButton.current?.focus();
    }
  }, [busy]);

  /** Sends the 6-digit code and goes to `/verify`; shows why when it cannot. */
  const sendCode = async (address: string) => {
    const res = await startEmail({ email: address, intent: "signin", next });
    if (res.kind === "sent") {
      router.push(pathWithRemember(res.next, remember));
      return; // keep the loading state until /verify replaces this page
    }
    setBusy(false);
    if (res.kind === "error" && res.code === "sso_required") {
      const required = ssoRequiredMatch(res.startUrl);
      if (required) {
        sso.remember(address, required);
        setSsoNotice(true);
        return;
      }
    }
    if (res.kind === "rate_limited") {
      const at = Date.now();
      setNow(at);
      setLimitedUntil(at + res.retryAfter * 1000);
      setError(rateLimitMessage(res.retryAfter));
    } else {
      setError(res.kind === "network" ? NETWORK_MESSAGE : res.kind === "error" ? errorMessage(res.code) : null);
    }
    setAutofillRound((n) => n + 1);
  };

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (busy || limited) return;
    if (!address) {
      setTouched(true);
      emailInput.current?.focus();
      return;
    }
    // Only one WebAuthn request may be pending: the autofill one goes before anything else.
    stopAutofill();
    setBusy(true);
    setError(null);
    setSsoNotice(false);
    if (!remembered) writeDraft(address);
    // 1. An enforced domain never gets a code or a passkey prompt (the lookup may still be pending).
    const found = await sso.resolve(address);
    if (found.kind === "match" && found.match.enforced) {
      markPending("sso");
      window.location.assign(withRemember(found.match.startUrl, remember));
      return;
    }
    // 2. The passkey this device last signed in with.
    if (passkeyFirst) {
      const res = await signInWithPasskey({ mediation: "optional", email: address, next, remember });
      if (res.ok) return signedIn(res, address);
      if (res.code === "passkey_unknown") {
        // Gone from the account: forget the shortcut (no sign-in happened, so keep its "last used")
        // and send a code straight away.
        rememberAccount(address, undefined, remembered?.at);
        setPasskeyFailed(true);
        return sendCode(address);
      }
      setBusy(false);
      // Offline or throttled is not the passkey's fault: say so and keep the passkey route.
      const transient = res.code === "network_error" || res.code === "rate_limited";
      if (!transient) setPasskeyFailed(true);
      setError(transient ? passkeyError(res.code) : PASSKEY_FALLBACK);
      focusContinue.current = true;
      return;
    }
    // 3. The email code.
    await sendCode(address);
  };

  /** The secondary "Passkey" button: any passkey, including one on a phone or a security key. */
  const passkey = async () => {
    if (passkeyBusy || busy) return;
    stopAutofill();
    setPasskeyBusy(true);
    setError(null);
    const res = await signInWithPasskey({ mediation: "optional", email: address ?? undefined, next, remember });
    if (res.ok) return signedIn(res, address ?? undefined);
    setPasskeyBusy(false);
    const problem = passkeyError(res.code);
    setError(problem);
    if (problem) setPasskeyFailed(true);
    setAutofillRound((n) => n + 1);
  };

  const notYou = () => {
    stopAutofill();
    forgetAccount();
    forgetSignIn();
    setLast(null);
    focusEmail.current = true;
    setRemembered(null);
    setEmail("");
    setTouched(false);
    setError(null);
    setPasskeyFailed(false);
  };

  const genericSSO = async () => {
    if (ssoBusy) return;
    // The passkey autofill stays on: a lookup does not compete with it, and leaving the page ends it.
    setSsoBusy(true);
    setError(null);
    const problem = await sso.go(address, remember);
    if (problem === null) return; // navigating to the identity provider
    setSsoBusy(false);
    if (!address) setTouched(true);
    setError(problem);
  };

  // The passkey button leads the form. An enforced organization refuses every other way in
  // (codes, passkeys, Google, GitHub), so only its SSO shows.
  const showPasskey = passkeys && !enforced;
  const others = altMethods(methods, { email: false }).filter((m) => !enforced && !(m === "sso" && sso.match));
  const errorText = limited ? rateLimitMessage(waitLeft) : error;

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
      {last && !remembered ? (
        <p className="ob-hint plain" data-testid="last-signin">
          <span>
            Last time you signed in as <b>{last.email}</b> with {METHOD_WORDS[last.method]}.{" "}
            <button
              type="button"
              className="cp-link"
              onClick={() => {
                forgetSignIn();
                setLast(null);
              }}
            >
              Not you?
            </button>
          </span>
        </p>
      ) : null}
      {showPasskey ? (
        <>
          <button type="button" className={`ah-btn ah-btn--secondary au-btn-full${passkeyBusy ? " is-loading" : ""}`} onClick={passkey} disabled={passkeyBusy} aria-busy={passkeyBusy || undefined}>
            <ObIcon name="finger" />
            Passkey
          </button>
          <div className="ob-or">or</div>
        </>
      ) : null}
      <form onSubmit={submit} noValidate>
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
                <input ref={emailInput} id="si-email" name="email" type="email" autoComplete="username webauthn" autoCapitalize="none" spellCheck={false} autoFocus placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} onBlur={() => email.trim() && setTouched(true)} aria-invalid={bad} aria-describedby={describedBy(bad && "si-err", showTypo && "si-typo", errorText && "si-problem")} />
              </div>
              {bad ? (
                <p id="si-err" className="ob-err">
                  Enter a work email like you@company.com.
                </p>
              ) : null}
              {showTypo ? (
                <p id="si-typo" className="ob-hint plain">
                  <span>
                    Did you mean{" "}
                    <button
                      type="button"
                      className="cp-link"
                      onClick={() => {
                        setEmail(typo);
                        setDismissedTypo(typo);
                        emailInput.current?.focus();
                      }}
                    >
                      {typo}
                    </button>
                    ?
                  </span>
                </p>
              ) : null}
            </>
          )}
          {errorText ? (
            <p id="si-problem" className="ob-err" role="alert">
              {errorText}
            </p>
          ) : null}
        </div>
        <div className="ob-note">
          <ObIcon name={enforced ? "lock" : passkeyFirst ? "finger" : "info"} />
          {enforced && sso.match ? (
            <span>
              {sso.match.orgName ? <b>{sso.match.orgName}</b> : "Your organization"} signs in with single sign-on.
            </span>
          ) : passkeyFirst ? (
            <span>You’ll confirm with the passkey you used on this device.</span>
          ) : (
            <span>We’ll email you a 6-digit code. There’s no password to remember.</span>
          )}
        </div>
        <KeepSignedIn checked={remember} onChange={setRemember} disabled={busy} />
        <div style={{ marginTop: 18 }}>
          {enforced && sso.match ? (
            <SSOLink match={sso.match} remember={remember} primary />
          ) : (
            <button ref={continueButton} type="submit" className={`ah-btn ah-btn--primary au-btn-full${busy ? " is-loading" : ""}${limited ? " is-disabled" : ""}`} disabled={busy || limited} aria-busy={busy || undefined}>
              Continue
              <ObIcon name="next" />
            </button>
          )}
        </div>
        {sso.match && !enforced ? (
          <div style={{ marginTop: 10 }}>
            <SSOLink match={sso.match} remember={remember} />
          </div>
        ) : null}
      </form>
      {others.length > 0 ? (
        <>
          <div className="ob-or">or</div>
          <div style={{ display: "grid", gridTemplateColumns: gridColumns(others.length), gap: 10 }}>
            {others.map((m) =>
              m === "sso" ? (
                <SSOButton key={m} busy={ssoBusy} onClick={genericSSO} />
              ) : m === "email" ? null : (
                <AltLink key={m} method={m} href={withRemember(oauth?.[m] ?? "/sign-in", remember)} />
              ),
            )}
          </div>
        </>
      ) : null}
    </ObShell>
  );
}
