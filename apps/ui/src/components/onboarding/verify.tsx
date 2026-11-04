"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { DEFAULT_RETRY_AFTER, NETWORK_MESSAGE, errorMessage, startEmail } from "@/lib/email-start";
import {
  EXPIRED_MESSAGE,
  LOCKED_MESSAGE,
  MAX_CODE_ATTEMPTS,
  NEW_USER_PATH,
  VERIFY_NETWORK_MESSAGE,
  countdown,
  verifyEmailCode,
  verifyErrorMessage,
  verifyRateLimitMessage,
  wrongCodeMessage,
} from "@/lib/email-verify";
import { rememberAccount } from "@/lib/remembered-account";
import { KeepSignedIn } from "./keep-signed-in";
import { BackNext, ObIcon, ObShell } from "./ob";

/** "Keep me signed in" starts checked (30-day session); unchecked asks for 24 hours (#322). */
const DEFAULT_REMEMBER = true;

type Problem =
  | { kind: "invalid_code"; left: number }
  | { kind: "code_expired" }
  | { kind: "too_many_attempts" }
  | { kind: "rate_limited" }
  | { kind: "network" }
  | { kind: "error"; code: string }
  | { kind: "resend"; message: string };

/** Whole seconds from a query value, or 0. */
function secondsParam(raw: string | null): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.ceil(n), 3600) : 0;
}

/** Counts `seconds` down to zero, one tick a second. */
function useCountdown(initial: number) {
  const [left, setLeft] = useState(initial);
  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);
  return [left, setLeft] as const;
}

/**
 * Six boxes over one real input, so typing, paste, autofill and one-time-code all work. The code
 * goes to `/api/auth/email/verify`; "Resend code" asks `/api/auth/email/start` again and restarts
 * the countdown from the server's `retry_after`.
 */
export function Verify() {
  const router = useRouter();
  const params = useSearchParams();
  const email = params.get("email")?.trim() ?? "";
  const signin = params.get("flow") !== "signup";
  const asked = params.get("next") ?? undefined;
  const input = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const [resending, setResending] = useState(false);
  const [wrong, setWrong] = useState(0);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [sent, setSent] = useState(false);
  const [shake, setShake] = useState(false);
  const [remember, setRemember] = useState(DEFAULT_REMEMBER);
  // The resend cooldown starts where `/api/auth/email/start` said (`retry_after`, #313).
  const [left, setLeft] = useCountdown(secondsParam(params.get("retry_after")));
  // A verify rate limit (429 `rate_limited`) blocks checking codes until it runs out.
  const [wait, setWait] = useCountdown(0);

  // No address to check a code against: start over.
  useEffect(() => {
    if (email) return;
    router.replace(asked ? `/sign-in?${new URLSearchParams({ next: asked })}` : "/sign-in");
  }, [email, asked, router]);

  useEffect(() => {
    if (problem?.kind === "rate_limited" && wait <= 0) setProblem(null);
  }, [problem, wait]);

  if (!email) return null;

  const locked = problem?.kind === "too_many_attempts";
  const ready = code.length === 6 && !sending && !locked && wait <= 0;

  const verify = async (value = code) => {
    if (value.length !== 6 || sending || locked || wait > 0) return;
    setSending(true);
    setProblem(null);
    setSent(false);
    const res = await verifyEmailCode({
      email,
      code: value,
      remember,
      next: asked ?? (signin ? undefined : NEW_USER_PATH),
    });
    if (res.kind === "signed_in" || res.kind === "2fa_required") {
      if (signin) rememberAccount(email);
      router.replace(res.next);
      return; // keep the loading state until the next page replaces this one
    }
    setSending(false);
    switch (res.kind) {
      case "invalid_code": {
        const n = wrong + 1;
        setWrong(n);
        setCode("");
        setShake(true);
        setProblem({ kind: "invalid_code", left: MAX_CODE_ATTEMPTS - n });
        input.current?.focus();
        break;
      }
      case "rate_limited":
        setWait(res.retryAfter);
        setProblem({ kind: "rate_limited" });
        break;
      case "too_many_attempts":
        setCode("");
        setProblem(res);
        break;
      default:
        setProblem(res);
    }
  };

  const resend = async () => {
    if (resending || left > 0) return;
    setResending(true);
    setSent(false);
    const res = await startEmail({ email, intent: signin ? "signin" : "signup", next: asked });
    setResending(false);
    switch (res.kind) {
      case "sent":
        setLeft(res.retryAfter ?? DEFAULT_RETRY_AFTER);
        setWrong(0);
        setCode("");
        setProblem(null);
        setSent(true);
        input.current?.focus();
        break;
      case "rate_limited":
        setLeft(res.retryAfter);
        setProblem({ kind: "resend", message: `Too many codes requested. You can ask for a new one in ${countdown(res.retryAfter)}.` });
        break;
      case "network":
        setProblem({ kind: "resend", message: NETWORK_MESSAGE });
        break;
      default:
        setProblem({ kind: "resend", message: errorMessage(res.code) });
    }
  };

  const problemText = (() => {
    switch (problem?.kind) {
      case "invalid_code":
        return wrongCodeMessage(problem.left);
      case "code_expired":
        return EXPIRED_MESSAGE;
      case "too_many_attempts":
        return LOCKED_MESSAGE;
      case "rate_limited":
        return verifyRateLimitMessage(wait);
      case "network":
        return VERIFY_NETWORK_MESSAGE;
      case "error":
        return verifyErrorMessage(problem.code);
      case "resend":
        return problem.message;
      default:
        return null;
    }
  })();
  const offerResend = problem?.kind === "code_expired" || problem?.kind === "too_many_attempts";

  const mail = (host: string) => `https://${host}`;
  const cell = (i: number) => (
    <span key={i} className={i === code.length && !locked ? "cur" : undefined}>
      {code[i] ?? ""}
    </span>
  );

  return (
    <ObShell
      eyebrow="02:19 AM"
      headline={["Everyone has", "a theory. Nobody", "has proof."]}
      body="“Was it the deploy?” “Is it the database?” “It works for me.”"
      receipt={
        <>
          #incident · <b>47</b> messages · <b>0</b> answers
        </>
      }
      progress={16.67}
      step={signin ? undefined : 0}
      badge="mail"
      title="Check your inbox"
      lead={
        <>
          Enter the 6-digit code we sent to <b>{email}</b>.
        </>
      }
      footer={<BackNext back={signin ? "/sign-in" : "/sign-up"} nextLabel="Verify" disabled={!ready} loading={sending} onNext={() => verify()} />}
    >
      <div
        className={`ob-code6${shake ? " is-shake" : ""}${locked ? " is-locked" : ""}`}
        onClick={() => input.current?.focus()}
        onAnimationEnd={() => setShake(false)}
      >
        {[0, 1, 2].map(cell)}
        <span className="gap" />
        {[3, 4, 5].map(cell)}
        <input
          ref={input}
          value={code}
          onChange={(e) => {
            const next = e.target.value.replace(/\D/g, "").slice(0, 6);
            setCode(next);
            if (problem?.kind === "invalid_code" || problem?.kind === "network" || problem?.kind === "error") setProblem(null);
            // A pasted or autofilled code submits itself.
            if (next.length === 6 && code.length < 6) void verify(next);
          }}
          onKeyDown={(e) => e.key === "Enter" && verify()}
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          maxLength={6}
          disabled={locked}
          aria-label="6-digit code"
          aria-invalid={problem?.kind === "invalid_code" || undefined}
          aria-describedby={problemText ? "verify-problem" : undefined}
        />
      </div>
      <div aria-live="polite">
        {problemText ? (
          <p id="verify-problem" className="ob-err" role="alert">
            {problemText}
            {offerResend && left <= 0 ? (
              <>
                {" "}
                <button type="button" className="cp-link" onClick={resend} disabled={resending}>
                  Send a new code
                </button>
              </>
            ) : null}
            {problem?.kind === "network" ? (
              <>
                {" "}
                <button type="button" className="cp-link" onClick={() => verify()}>
                  Try again
                </button>
              </>
            ) : null}
          </p>
        ) : sent ? (
          <div className="ob-note">
            <ObIcon name="done" />
            <span>
              We sent a new code to <b>{email}</b>.
            </span>
          </div>
        ) : (
          <div className="ob-note">
            <ObIcon name="info" />
            <span>Paste the whole code, or open the link in the email.</span>
          </div>
        )}
      </div>
      <KeepSignedIn checked={remember} onChange={setRemember} disabled={sending} />
      <div className="ob-actions">
        <a className="ah-btn ah-btn--secondary ah-btn--sm" href={mail("mail.google.com")} target="_blank" rel="noreferrer">
          <ObIcon name="out" />
          Open Gmail
        </a>
        <a className="ah-btn ah-btn--secondary ah-btn--sm" href={mail("outlook.live.com")} target="_blank" rel="noreferrer">
          <ObIcon name="out" />
          Open Outlook
        </a>
        <button
          type="button"
          className={`ah-btn ah-btn--ghost ah-btn--sm${left > 0 ? " is-disabled" : ""}${resending ? " is-loading" : ""}`}
          onClick={resend}
          disabled={left > 0 || resending}
          aria-busy={resending || undefined}
        >
          <ObIcon name="redo" />
          {left > 0 ? `Resend in ${countdown(left)}` : "Resend code"}
        </button>
      </div>
    </ObShell>
  );
}
