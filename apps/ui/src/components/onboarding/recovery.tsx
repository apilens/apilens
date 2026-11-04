"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import type { RecoveryView } from "@/lib/recovery";
import {
  NETWORK_MESSAGE,
  RECOVERY_PATH,
  type RecoveryResult,
  countdown,
  postRecovery,
  recoveryErrorMessage,
  waitMessage,
} from "@/lib/recovery-client";
import { ObIcon, type ObIconName, ObShell, describedBy } from "./ob";

const valid = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e.trim());

/** Every recovery screen shares one brand panel. */
function RecoveryShell({ badge, title, lead, children, below }: { badge: ObIconName; title: string; lead: ReactNode; children?: ReactNode; below?: ReactNode }) {
  return (
    <ObShell
      eyebrow="Lost device"
      headline={["Locked out is", "temporary. Your", "account isn’t."]}
      body="Recovery waits 24 hours before it turns two-factor off, so the real owner always has time to say no."
      receipt={
        <>
          cooling-off · <b>24 h</b> · cancel any time
        </>
      }
      badge={badge}
      title={title}
      lead={lead}
      below={
        below ?? (
          <>
            Back to <Link className="cp-link" href="/sign-in">sign in</Link>
          </>
        )
      }
    >
      {children}
    </ObShell>
  );
}

/** Inline copy for a failed recovery call. */
function failureMessage(res: RecoveryResult): string {
  switch (res.kind) {
    case "rate_limited":
      return waitMessage(res.retryAfter);
    case "network":
      return NETWORK_MESSAGE;
    case "invalid_token":
      return "This link has expired, was cancelled or was already used.";
    case "error":
      return recoveryErrorMessage(res.code);
    default:
      return recoveryErrorMessage("");
  }
}

// ---------------------------------------------------------------------------------------------
// /auth/recovery

/**
 * "Lost your device?" (#321): asks for the account's address. The answer never says whether an
 * account exists, so the sent state reads the same for every address.
 */
export function RecoveryRequest({ email: initial }: { email?: string }) {
  const [email, setEmail] = useState(initial ?? "");
  const [touched, setTouched] = useState(false);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bad = touched && !valid(email);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (sending) return;
    if (!valid(email)) return setTouched(true);
    setSending(true);
    setError(null);
    const res = await postRecovery("request", { email: email.trim() });
    setSending(false);
    if (res.kind === "ok") return setSent(email.trim());
    setError(failureMessage(res));
  };

  if (sent) {
    return (
      <RecoveryShell
        badge="mail"
        title="Check your inbox"
        lead={
          <>
            If an account exists for <b>{sent}</b>, we emailed instructions.
          </>
        }
      >
        <div className="ob-f" data-recovery="sent">
          <div className="ob-note">
            <ObIcon name="lock" />
            <span>
              For your safety, two-factor stays on for <b>24 hours</b>. We email you again when you can finish.
            </span>
          </div>
          <div className="ob-note">
            <ObIcon name="info" />
            <span>Didn’t ask for this? Use the cancel link in that email.</span>
          </div>
        </div>
        <div className="ob-actions">
          <button
            type="button"
            className="ah-btn ah-btn--secondary ah-btn--sm"
            onClick={() => {
              setSent(null);
              setTouched(false);
            }}
          >
            <ObIcon name="redo" />
            Use a different email
          </button>
        </div>
      </RecoveryShell>
    );
  }

  return (
    <RecoveryShell
      badge="lock"
      title="Lost your device?"
      lead="Enter your account’s email. We’ll send instructions to turn off two-factor authentication after a 24-hour waiting period."
    >
      <form className="ob-f" onSubmit={send} noValidate data-recovery="request">
        <label className="ob-l" htmlFor="rc-email">
          Work email
        </label>
        <div className={`ob-in${bad ? " bad" : ""}`}>
          <ObIcon name="mail" />
          <input
            id="rc-email"
            name="email"
            type="email"
            autoComplete="email"
            autoFocus={!initial}
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onBlur={() => setTouched(true)}
            aria-invalid={bad}
            aria-describedby={describedBy(bad && "rc-err", error && "rc-problem")}
          />
        </div>
        {bad ? (
          <p id="rc-err" className="ob-err">
            Enter a work email like you@company.com.
          </p>
        ) : null}
        {error ? (
          <p id="rc-problem" className="ob-err" role="alert">
            {error}
          </p>
        ) : null}
        <div style={{ marginTop: 14 }}>
          <button type="submit" className={`ah-btn ah-btn--primary au-btn-full${sending ? " is-loading" : ""}`} disabled={sending} aria-busy={sending || undefined}>
            Send instructions
            <ObIcon name="next" />
          </button>
        </div>
      </form>
    </RecoveryShell>
  );
}

// ---------------------------------------------------------------------------------------------
// Shared link states

type DeadView = Extract<RecoveryView, { kind: "confirmed" | "cancelled" | "invalid" | "rate_limited" | "error" }>;

/** A recovery link that cannot do anything (any more). */
function DeadLink({ view }: { view: DeadView }) {
  switch (view.kind) {
    case "confirmed":
      return (
        <RecoveryShell badge="done" title="Recovery already completed" lead={<>This request (made {view.requestedAt}) already turned off two-factor authentication. Sign in, then set it up again.</>}>
          <Actions primary={{ href: "/sign-in", label: "Sign in", icon: "next" }} />
        </RecoveryShell>
      );
    case "cancelled":
      return (
        <RecoveryShell badge="lock" title="Recovery cancelled" lead={<>This request (made {view.requestedAt}) was cancelled or replaced by a newer one. Two-factor authentication is still on.</>}>
          <Actions primary={{ href: RECOVERY_PATH, label: "Start a new request", icon: "redo" }} />
        </RecoveryShell>
      );
    case "rate_limited":
      return (
        <RecoveryShell badge="info" title="Slow down" lead={waitMessage(view.retryAfter)}>
          <Actions primary={{ href: "", label: "Try again", icon: "redo" }} reload />
        </RecoveryShell>
      );
    case "error":
      return (
        <RecoveryShell badge="info" title="We couldn’t load this request" lead="Something went wrong on our side. Your request is unchanged. Try again in a moment.">
          <Actions primary={{ href: "", label: "Try again", icon: "redo" }} reload />
        </RecoveryShell>
      );
    default:
      return (
        <RecoveryShell badge="link" title="Link not valid" lead="This recovery link is unknown, was cancelled or was already used. Start a new request if you still can’t sign in.">
          <Actions primary={{ href: RECOVERY_PATH, label: "Start a new request", icon: "redo" }} />
        </RecoveryShell>
      );
  }
}

function Actions({ primary, reload }: { primary: { href: string; label: string; icon: ObIconName }; reload?: boolean }) {
  return (
    <div style={{ display: "grid", gap: 10, marginTop: 22 }}>
      {reload ? (
        <button type="button" className="ah-btn ah-btn--primary au-btn-full" onClick={() => window.location.reload()}>
          <ObIcon name={primary.icon} />
          {primary.label}
        </button>
      ) : (
        <Link className="ah-btn ah-btn--primary au-btn-full" href={primary.href}>
          {primary.label}
          <ObIcon name={primary.icon} />
        </Link>
      )}
    </div>
  );
}

/**
 * Seconds left until `ready`, ticking once a second. `target` is a fresh starting value: the
 * server's on first render, identity's `retry_after` after a `recovery_not_ready` answer.
 */
function useCountdown(target: { seconds: number }): number {
  const [left, setLeft] = useState(target.seconds);
  useEffect(() => {
    setLeft(target.seconds);
    if (target.seconds <= 0) return;
    const end = Date.now() + target.seconds * 1000;
    const id = window.setInterval(() => {
      const s = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) window.clearInterval(id);
    }, 1000);
    return () => window.clearInterval(id);
  }, [target]);
  return left;
}

// ---------------------------------------------------------------------------------------------
// /auth/recovery/status?token=

type LiveView = Extract<RecoveryView, { kind: "pending" | "ready" }>;

/**
 * Where a recovery request stands (#321): a countdown to `ready_at` while pending, then
 * "Disable two-factor and sign in", which confirms and lands signed in.
 */
export function RecoveryStatusPage({ view }: { view: RecoveryView }) {
  if (view.kind !== "pending" && view.kind !== "ready") return <DeadLink view={view} />;
  return <RecoveryLive view={view} />;
}

function RecoveryLive({ view }: { view: LiveView }) {
  const router = useRouter();
  const [target, setTarget] = useState(() => ({ seconds: view.kind === "pending" ? view.secondsLeft : 0 }));
  const left = useCountdown(target);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dead, setDead] = useState(false);
  const ready = left <= 0;

  const confirm = async () => {
    if (busy || !ready) return;
    setBusy(true);
    setError(null);
    const res = await postRecovery("confirm", { token: view.token });
    if (res.kind === "ok") {
      router.replace(res.next);
      router.refresh();
      return;
    }
    setBusy(false);
    if (res.kind === "not_ready") {
      // Our clock ran ahead of identity's: count down what it says is left.
      setTarget({ seconds: res.retryAfter ?? 60 });
      return;
    }
    if (res.kind === "invalid_token") return setDead(true);
    setError(failureMessage(res));
  };

  if (dead) return <DeadLink view={{ kind: "invalid" }} />;

  return (
    <RecoveryShell
      badge={ready ? "lock" : "info"}
      title={ready ? "Recovery is ready" : "Recovery is pending"}
      lead={
        ready ? (
          "The waiting period is over. Turn off two-factor authentication to sign in, then set it up again on your new device."
        ) : (
          <>
            For your safety, two-factor stays on until <b>{view.readyAt}</b>. Keep this page open or use the link in the email we send then.
          </>
        )
      }
    >
      <div className="ob-f" data-recovery={ready ? "ready" : "pending"}>
        <div className="ob-row">
          <ObIcon name={ready ? "done" : "lock"} />
          <span className="t">
            <b aria-live="polite" aria-atomic="true">
              {ready ? "Ready to finish" : `Ready in ${countdown(left)}`}
            </b>
            <small>Requested {view.requestedAt}</small>
          </span>
        </div>
        {error ? (
          <p className="ob-err" role="alert">
            {error}
          </p>
        ) : null}
        <div style={{ marginTop: 14 }}>
          <button
            type="button"
            className={`ah-btn ah-btn--primary au-btn-full${busy ? " is-loading" : ""}${ready ? "" : " is-disabled"}`}
            onClick={confirm}
            disabled={busy || !ready}
            aria-disabled={busy || !ready || undefined}
            aria-busy={busy || undefined}
          >
            Disable two-factor and sign in
            <ObIcon name="next" />
          </button>
        </div>
        <div className="ob-note">
          <ObIcon name="info" />
          <span>Finishing signs out every other session.</span>
        </div>
      </div>
      <div className="ob-actions">
        <Link className="ah-btn ah-btn--ghost ah-btn--sm" href={`/auth/recovery/cancel?${new URLSearchParams({ token: view.token })}`} prefetch={false}>
          Didn’t ask for this? Cancel the request
        </Link>
      </div>
    </RecoveryShell>
  );
}

// ---------------------------------------------------------------------------------------------
// /auth/recovery/cancel?token=

/**
 * Cancel from the alert email (#321). Opening the link changes nothing (mail scanners open
 * links); the button does.
 */
export function RecoveryCancelPage({ view }: { view: RecoveryView }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [dead, setDead] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (view.kind !== "pending" && view.kind !== "ready") {
    // Cancelling one already cancelled is a success to the person who clicked.
    if (view.kind === "cancelled") return <Cancelled />;
    return <DeadLink view={view} />;
  }
  if (done) return <Cancelled />;
  if (dead) return <DeadLink view={{ kind: "invalid" }} />;

  const cancel = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const res = await postRecovery("cancel", { token: view.token });
    setBusy(false);
    if (res.kind === "ok") return setDone(true);
    if (res.kind === "invalid_token") return setDead(true);
    setError(failureMessage(res));
  };

  return (
    <RecoveryShell
      badge="lock"
      title="Cancel account recovery?"
      lead={
        <>
          Someone asked to turn off two-factor authentication on your account on <b>{view.requestedAt}</b>. If it wasn’t you, cancel it.
        </>
      }
    >
      <div className="ob-f" data-recovery="cancel">
        {error ? (
          <p className="ob-err" role="alert">
            {error}
          </p>
        ) : null}
        <div style={{ marginTop: 14 }}>
          <button type="button" className={`ah-btn ah-btn--primary au-btn-full${busy ? " is-loading" : ""}`} onClick={cancel} disabled={busy} aria-busy={busy || undefined}>
            <ObIcon name="lock" />
            Cancel recovery and keep two-factor on
          </button>
        </div>
        <div className="ob-note">
          <ObIcon name="info" />
          <span>Requesting recovery only needs your address. Nothing has changed yet.</span>
        </div>
      </div>
    </RecoveryShell>
  );
}

function Cancelled() {
  return (
    <RecoveryShell badge="done" title="Recovery cancelled" lead="Two-factor authentication stays on. Nothing about your account changed.">
      <Actions primary={{ href: "/sign-in", label: "Sign in", icon: "next" }} />
    </RecoveryShell>
  );
}
