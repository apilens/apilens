"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { NETWORK_MESSAGE, errorMessage, rateLimitMessage, startEmail } from "@/lib/email-start";
import { LINKS, extLink } from "@/lib/links";
import { type OAuthLinks, type SignInMethods, altMethods, gridColumns } from "@/lib/sign-in-methods";
import { AltLink } from "./alt-method";
import { ObIcon, ObShell } from "./ob";

const valid = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e.trim());

type Problem = { kind: "network" } | { kind: "rate_limited"; until: number } | { kind: "error"; code: string };

/**
 * The email form is always shown; `methods` adds the provider row under it when any are on.
 * Continue asks `/api/auth/email/start` to send the code, then goes to `/verify` with the
 * server's resend cooldown (`retry_after`). `oauth` holds the Google/GitHub start URLs (built on
 * the server). `next` is where to land after verifying.
 */
export function SignUp({ methods, oauth, next }: { methods: SignInMethods; oauth?: OAuthLinks; next?: string }) {
  const router = useRouter();
  const alts = altMethods(methods, { email: false });
  const [email, setEmail] = useState("");
  const [touched, setTouched] = useState(false);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const bad = touched && !valid(email);

  const limited = problem?.kind === "rate_limited" ? problem : null;
  const waitLeft = limited ? Math.ceil((limited.until - now) / 1000) : 0;
  useEffect(() => {
    if (!limited) return;
    if (waitLeft <= 0) {
      setProblem(null);
      return;
    }
    const t = setTimeout(() => setNow(Date.now()), 1000);
    return () => clearTimeout(t);
  }, [limited, waitLeft]);

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setTouched(true);
    if (!valid(email) || sending || limited) return;
    setSending(true);
    setProblem(null);
    const res = await startEmail({ email: email.trim(), intent: "signup", next });
    if (res.kind === "sent") {
      router.push(res.next);
      return; // keep the loading state until /verify replaces this page
    }
    setSending(false);
    if (res.kind === "rate_limited") {
      const at = Date.now();
      setNow(at);
      setProblem({ kind: "rate_limited", until: at + res.retryAfter * 1000 });
    } else {
      setProblem(res);
    }
  };

  const problemText =
    problem?.kind === "network" ? NETWORK_MESSAGE : limited ? rateLimitMessage(waitLeft) : problem?.kind === "error" ? errorMessage(problem.code) : null;

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
            <input id="su-email" type="email" autoComplete="email" autoFocus placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} onBlur={() => email && setTouched(true)} aria-invalid={bad} aria-describedby={bad ? "su-err" : problemText ? "su-problem" : undefined} />
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
        <div aria-live="polite">
          {problemText ? (
            <p id="su-problem" className="ob-err">
              {problemText}
              {problem?.kind === "network" ? (
                <>
                  {" "}
                  <button type="button" className="cp-link" onClick={() => submit()}>
                    Try again
                  </button>
                </>
              ) : null}
            </p>
          ) : null}
        </div>
        <div style={{ marginTop: 22 }}>
          <button type="submit" className={`ah-btn ah-btn--primary au-btn-full${sending ? " is-loading" : ""}${limited ? " is-disabled" : ""}`} disabled={sending || !!limited} aria-busy={sending || undefined}>
            Continue
            <ObIcon name="next" />
          </button>
        </div>
      </form>
      {alts.length > 0 ? (
        <>
          <div className="ob-or">or</div>
          <div style={{ display: "grid", gridTemplateColumns: gridColumns(alts.length), gap: 10 }}>
            {alts.map((m) =>
              m === "email" ? null : (
                <AltLink key={m} method={m} href={m === "sso" ? "/onboarding/about" : (oauth?.[m] ?? "/sign-up")} />
              ),
            )}
          </div>
        </>
      ) : null}
    </ObShell>
  );
}
