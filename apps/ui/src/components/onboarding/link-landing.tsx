"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useState } from "react";
import { NETWORK_MESSAGE, errorMessage, rateLimitMessage, startEmail } from "@/lib/email-start";
import { emailInitials } from "@/lib/remembered-account";
import { ObIcon, type ObIconName, ObShell } from "./ob";

const valid = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e.trim());

/** The magic-link screens share the "check your inbox" brand panel. */
function LinkShell({ badge, title, lead, children, below }: { badge: ObIconName; title: string; lead: ReactNode; children: ReactNode; below?: ReactNode }) {
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
      badge={badge}
      title={title}
      lead={lead}
      below={below}
    >
      {children}
    </ObShell>
  );
}

/** `/verify` with `next` (and `email`) kept, for "enter the code instead". */
function codePath(email: string | undefined, next: string | undefined): string {
  const q = new URLSearchParams({ flow: "signin" });
  if (email) q.set("email", email);
  if (next) q.set("next", next);
  return `/verify?${q}`;
}

/**
 * A magic link that could not sign in (#316). `expired`: identity answered `invalid_token` or
 * `code_expired` (unknown, used, superseded or past its lifetime). `error`: identity could not be
 * reached. Both offer a new link, with the address from the link prefilled.
 */
export function LinkProblem({ problem, email: initial, next }: { problem: "expired" | "error"; email?: string; next?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState(initial ?? "");
  const [touched, setTouched] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bad = touched && !valid(email);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (sending) return;
    if (!valid(email)) return setTouched(true);
    setSending(true);
    setError(null);
    const res = await startEmail({ email: email.trim(), intent: "signin", next });
    if (res.kind === "sent") return router.push(res.next);
    setSending(false);
    switch (res.kind) {
      case "rate_limited":
        setError(rateLimitMessage(res.retryAfter));
        break;
      case "network":
        setError(NETWORK_MESSAGE);
        break;
      default:
        setError(errorMessage(res.code));
    }
  };

  const expired = problem === "expired";
  return (
    <LinkShell
      badge="link"
      title={expired ? "Link expired" : "We couldn’t sign you in"}
      lead={
        expired
          ? "This link has expired or was already used. Send a new link to sign in."
          : "Something went wrong opening this link. Send a new link, or enter the code from the email."
      }
      below={
        <>
          Back to <Link className="cp-link" href={next ? `/sign-in?${new URLSearchParams({ next })}` : "/sign-in"}>sign in</Link>
        </>
      }
    >
      <form className="ob-f" onSubmit={send} noValidate data-link-problem={problem}>
        <label className="ob-l" htmlFor="ml-email">
          Work email
        </label>
        <div className={`ob-in${bad ? " bad" : ""}`}>
          <ObIcon name="mail" />
          <input
            id="ml-email"
            name="email"
            type="email"
            autoComplete="email"
            autoFocus={!initial}
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onBlur={() => setTouched(true)}
            aria-invalid={bad}
            aria-describedby={bad ? "ml-err" : undefined}
          />
        </div>
        {bad ? (
          <p id="ml-err" className="ob-err">
            Enter a work email like you@company.com.
          </p>
        ) : null}
        {error ? (
          <p className="ob-err" role="alert">
            {error}
          </p>
        ) : null}
        <div style={{ marginTop: 14 }}>
          <button type="submit" className={`ah-btn ah-btn--primary au-btn-full${sending ? " is-loading" : ""}`} disabled={sending} aria-busy={sending || undefined}>
            <ObIcon name="redo" />
            Send a new link
          </button>
        </div>
      </form>
      {!expired && valid(email) ? (
        <div className="ob-actions">
          <Link className="ah-btn ah-btn--secondary ah-btn--sm" href={codePath(email.trim(), next)}>
            <ObIcon name="mail" />
            Enter the code instead
          </Link>
        </div>
      ) : null}
    </LinkShell>
  );
}

/**
 * A magic link opened while signed in as someone else (#316). "Continue" keeps the current session
 * and leaves the link unused; "Switch" exchanges it, replacing the session.
 */
export function SignedInAs({ current, linkEmail, continueTo, switchTo }: { current: string; linkEmail?: string; continueTo: string; switchTo: string }) {
  return (
    <LinkShell
      badge="user"
      title="You’re already signed in"
      lead={
        linkEmail ? (
          <>
            You are signed in as <b>{current}</b>. This link signs in <b>{linkEmail}</b>.
          </>
        ) : (
          <>
            You are signed in as <b>{current}</b>. This link may sign in a different account.
          </>
        )
      }
    >
      <div className="ob-f">
        <div className="ob-row">
          <span className="cp-av cp-av--sm">{emailInitials(current)}</span>
          <span className="t">
            <b>{current}</b>
            <small>Signed in on this device</small>
          </span>
        </div>
      </div>
      <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
        <Link className="ah-btn ah-btn--primary au-btn-full" href={continueTo}>
          Continue as {current}
          <ObIcon name="next" />
        </Link>
        {/* A plain anchor: the exchange is a Route Handler navigation, and a prefetch would spend the link. */}
        <a className="ah-btn ah-btn--secondary au-btn-full" href={switchTo} rel="noreferrer">
          <ObIcon name="user" />
          {linkEmail ? `Switch to ${linkEmail}` : "Switch account"}
        </a>
      </div>
    </LinkShell>
  );
}
