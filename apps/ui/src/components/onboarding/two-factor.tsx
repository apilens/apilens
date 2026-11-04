"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { RECOVERY_PATH } from "@/lib/recovery-client";
import {
  MAX_TWO_FACTOR_ATTEMPTS,
  TWO_FACTOR_NETWORK_MESSAGE,
  type TwoFactorProof,
  cleanBackupCode,
  cleanTotp,
  exchangeTwoFactor,
  isBackupCode,
  startOverPath,
  twoFactorErrorMessage,
  wrongTwoFactorMessage,
} from "@/lib/two-factor";
import { BackNext, ObIcon, ObShell } from "./ob";

type Mode = "totp" | "backup";

type Problem = { kind: "invalid_code"; left: number } | { kind: "network" } | { kind: "error"; code: string };

/**
 * The two-factor step (#320): a sign-in (email code, magic link, Google/GitHub, SSO) answered
 * `2fa_required` and parked its pre-auth token in an httpOnly cookie. This page asks for the
 * 6-digit code from the authenticator app (or, toggled, a `xxxx-xxxx` backup code) and posts it to
 * `/api/auth/2fa/exchange`, which reads the token from that cookie. Identity allows five wrong
 * answers per pending sign-in; the fifth, or a pending sign-in that has expired, goes back to
 * sign-in with a notice. "Lost your device?" starts account recovery.
 */
export function TwoFactor({ next: asked }: { next?: string | null }) {
  const router = useRouter();
  const totpInput = useRef<HTMLInputElement>(null);
  const backupInput = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<Mode>("totp");
  const [code, setCode] = useState("");
  const [backup, setBackup] = useState("");
  const [sending, setSending] = useState(false);
  const [wrong, setWrong] = useState(0);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [shake, setShake] = useState(false);

  const usingBackup = mode === "backup";
  const ready = !sending && (usingBackup ? isBackupCode(backup) : code.length === 6);

  const submit = async (proof?: TwoFactorProof) => {
    const body: TwoFactorProof | null =
      proof ?? (usingBackup ? (isBackupCode(backup) ? { backup_code: backup } : null) : code.length === 6 ? { code } : null);
    if (!body || sending) return;
    setSending(true);
    setProblem(null);
    const res = await exchangeTwoFactor(body);
    switch (res.kind) {
      case "signed_in":
        router.replace(res.next);
        return; // keep the loading state until the next page replaces this one
      case "too_many_attempts":
        router.replace(startOverPath("2fa_locked", asked));
        return;
      case "expired":
        router.replace(startOverPath("2fa_expired", asked));
        return;
    }
    setSending(false);
    if (res.kind === "invalid_code") {
      const n = wrong + 1;
      setWrong(n);
      setProblem({ kind: "invalid_code", left: MAX_TWO_FACTOR_ATTEMPTS - n });
      if ("backup_code" in body) {
        backupInput.current?.select();
      } else {
        setCode("");
        setShake(true);
        totpInput.current?.focus();
      }
      return;
    }
    setProblem(res);
  };

  const toggle = () => {
    const next: Mode = usingBackup ? "totp" : "backup";
    setMode(next);
    setProblem(null);
    // Focus after the input for the new mode has rendered.
    requestAnimationFrame(() => (next === "backup" ? backupInput.current : totpInput.current)?.focus());
  };

  const problemText = (() => {
    switch (problem?.kind) {
      case "invalid_code":
        return wrongTwoFactorMessage(usingBackup, problem.left);
      case "network":
        return TWO_FACTOR_NETWORK_MESSAGE;
      case "error":
        return twoFactorErrorMessage(problem.code, usingBackup);
      default:
        return null;
    }
  })();
  const clearable = problem?.kind === "invalid_code" || problem?.kind === "network" || problem?.kind === "error";

  const cell = (i: number) => (
    <span key={i} className={i === code.length ? "cur" : undefined} aria-hidden="true">
      {code[i] ?? ""}
    </span>
  );

  return (
    <ObShell
      eyebrow="02:19 AM"
      headline={["One more step.", "Then you’re", "back on call."]}
      body="A second factor keeps the dashboard yours, even when a password or inbox isn’t."
      receipt={
        <>
          2fa · <b>totp</b> · 30 s window
        </>
      }
      badge="lock"
      title="Two-factor authentication"
      lead={
        usingBackup ? (
          <>Enter one of the backup codes you saved when you turned on two-factor. Each code works once.</>
        ) : (
          <>Enter the 6-digit code from your authenticator app.</>
        )
      }
      footer={<BackNext back="/sign-in" nextLabel="Verify" disabled={!ready} loading={sending} onNext={() => submit()} />}
    >
      {usingBackup ? (
        <form
          className="ob-f"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="ob-l" htmlFor="tf-backup">
            Backup code
          </label>
          <div className={`ob-in${problem?.kind === "invalid_code" ? " bad" : ""}`}>
            <ObIcon name="lock" />
            <input
              ref={backupInput}
              id="tf-backup"
              name="backup_code"
              value={backup}
              onChange={(e) => {
                setBackup(cleanBackupCode(e.target.value));
                if (clearable) setProblem(null);
              }}
              placeholder="xxxx-xxxx"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              maxLength={9}
              aria-invalid={problem?.kind === "invalid_code" || undefined}
              aria-describedby={problemText ? "tf-problem" : undefined}
            />
          </div>
        </form>
      ) : (
        <div className={`ob-code6${shake ? " is-shake" : ""}`} onClick={() => totpInput.current?.focus()} onAnimationEnd={() => setShake(false)}>
          {[0, 1, 2].map(cell)}
          <span className="gap" aria-hidden="true" />
          {[3, 4, 5].map(cell)}
          <input
            ref={totpInput}
            value={code}
            onChange={(e) => {
              const next = cleanTotp(e.target.value);
              setCode(next);
              if (clearable) setProblem(null);
              // A pasted or autofilled code submits itself.
              if (next.length === 6 && code.length < 6) void submit({ code: next });
            }}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            maxLength={6}
            aria-label="6-digit code"
            aria-invalid={problem?.kind === "invalid_code" || undefined}
            aria-describedby={problemText ? "tf-problem" : undefined}
          />
        </div>
      )}
      <div aria-live="polite">
        {problemText ? (
          <p id="tf-problem" className="ob-err" role="alert">
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
        ) : (
          <div className="ob-note">
            <ObIcon name="info" />
            <span>
              {usingBackup
                ? "Backup codes look like abcd-1234. Case and dashes don’t matter."
                : "Open your authenticator app and use the current code for APILens."}
            </span>
          </div>
        )}
      </div>
      <div className="ob-actions">
        <button type="button" className="ah-btn ah-btn--secondary ah-btn--sm" onClick={toggle} disabled={sending}>
          <ObIcon name={usingBackup ? "code" : "lock"} />
          {usingBackup ? "Use your authenticator app" : "Use a backup code"}
        </button>
        <Link className="ah-btn ah-btn--ghost ah-btn--sm" href={RECOVERY_PATH}>
          <ObIcon name="help" />
          Lost your device?
        </Link>
      </div>
    </ObShell>
  );
}
