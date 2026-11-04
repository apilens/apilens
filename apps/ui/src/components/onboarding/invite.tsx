"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { type InviteProblem, acceptPath, invitePath, inviteAuthPath, inviteProblem } from "@/lib/invitations";
import { readRememberedAccount } from "@/lib/remembered-account";
import { signOut } from "@/lib/sign-out";
import { ObIcon, type ObIconName, ObShell } from "./ob";

/** What the page learnt from the public lookup, ready to show (the role and expiry as text). */
export interface InviteSummary {
  orgName: string;
  orgSlug: string;
  inviterName: string;
  emailMasked: string;
  roleLabel: string;
  expiresIn: string;
}

function InviteShell({ org, badge, title, lead, children, below }: { org?: string; badge: ObIconName; title: string; lead: ReactNode; children?: ReactNode; below?: ReactNode }) {
  return (
    <ObShell
      eyebrow="02:20 AM"
      headline={["Nobody should", "debug alone", "at 2 AM."]}
      body="Your team already watches this API. Join them and see the same requests, traces and errors."
      receipt={
        org ? (
          <>
            invited · <b>{org}</b> · one click to join
          </>
        ) : (
          <>
            invitation · <b>no longer valid</b>
          </>
        )
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

/** An invitation that cannot be used: expired, revoked or accepted, or an unknown link. */
export function InviteUnavailable({ problem }: { problem: InviteProblem }) {
  const expired = problem === "invite_expired";
  const broken = problem === "error";
  return (
    <InviteShell
      badge="link"
      title={broken ? "We couldn’t open this invitation" : expired ? "Invitation expired" : "Invitation not found"}
      lead={
        broken
          ? "Something went wrong looking up this invitation. Try again in a moment."
          : expired
            ? "This invitation has expired, was revoked or was already used. Ask whoever invited you to send a new one."
            : "This invitation link isn’t valid. Check that you opened the whole link from the email, or ask for a new invitation."
      }
      below={
        <>
          Already a member? <Link className="cp-link" href="/sign-in">Sign in</Link>
        </>
      }
    />
  );
}

/**
 * The invitation (#337): the organization, who invited you, the invited address (masked) and the
 * role. Signed out, "Accept invitation" signs up (or signs in when this device remembers an
 * account) and comes back here; signed in, it accepts through the Route Handler.
 */
export function InviteLanding({ token, invite, signedInAs }: { token: string; invite: InviteSummary; signedInAs?: string }) {
  const router = useRouter();
  const [remembered, setRemembered] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<InviteProblem | null>(null);

  // localStorage is only readable after hydration; until then the link signs up.
  useEffect(() => setRemembered(readRememberedAccount() !== null), []);

  const signInAsInvited = async () => {
    setBusy(true);
    await signOut();
    window.location.assign(inviteAuthPath(token, true));
  };

  const accept = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch(acceptPath(token), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "same-origin",
        body: "{}",
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; next?: string; code?: string } | null;
      if (res.ok && body?.ok && typeof body.next === "string") {
        router.push(body.next);
        router.refresh();
        return;
      }
      // The session ended in the meantime: sign in again and come back.
      if (res.status === 401 && body?.code !== "invite_email_mismatch") {
        window.location.assign(`/sign-in?${new URLSearchParams({ next: invitePath(token) })}`);
        return;
      }
      setProblem(inviteProblem(body?.code));
    } catch {
      setProblem("error");
    }
    setBusy(false);
  };

  if (problem === "invite_expired" || problem === "invalid_token") return <InviteUnavailable problem={problem} />;

  const inviter = invite.inviterName.trim();
  const a = /^[aeiou]/i.test(invite.roleLabel) ? "an" : "a";
  const mismatch = problem === "invite_email_mismatch";
  return (
    <InviteShell
      org={invite.orgName}
      badge="team"
      title={`Join ${invite.orgName} on APILens`}
      lead={
        inviter ? (
          <>
            <b>{inviter}</b> invited you to join <b>{invite.orgName}</b> as {a} <b>{invite.roleLabel}</b>.
          </>
        ) : (
          <>
            You’re invited to join <b>{invite.orgName}</b> as {a} <b>{invite.roleLabel}</b>.
          </>
        )
      }
      below={
        signedInAs ? (
          <>
            Signed in as <b>{signedInAs}</b>
          </>
        ) : undefined
      }
    >
      <div className="ob-f">
        <div className="ob-card">
          <div style={{ display: "flex", alignItems: "center", gap: 14, padding: 16 }}>
            <span className="cp-orgmark" style={{ width: 44, height: 44, borderRadius: 12, fontSize: 17 }} aria-hidden="true">
              {(invite.orgName.trim()[0] ?? invite.orgSlug[0] ?? "?").toUpperCase()}
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <b style={{ display: "block", font: "600 16px/22px var(--font-sans)" }}>{invite.orgName}</b>
              <small style={{ display: "block", font: "400 13px/18px var(--font-mono)", color: "var(--ink-muted)" }}>{invite.orgSlug}</small>
            </span>
          </div>
          <div className="ob-row" style={{ border: 0, borderTop: "1px solid var(--border)", borderRadius: 0 }}>
            <ObIcon name="mail" />
            <span className="t">
              <b data-testid="invite-email">{invite.emailMasked}</b>
              <small>{invite.expiresIn}</small>
            </span>
          </div>
        </div>
      </div>

      {mismatch ? (
        <div role="alert" style={{ marginTop: 14 }}>
          <p className="ob-err">
            This invitation is for <b>{invite.emailMasked}</b>
            {signedInAs ? (
              <>
                , but you’re signed in as <b>{signedInAs}</b>
              </>
            ) : null}
            .
          </p>
          <div style={{ marginTop: 14 }}>
            <button type="button" className={`ah-btn ah-btn--primary au-btn-full${busy ? " is-loading" : ""}`} onClick={signInAsInvited} disabled={busy} aria-busy={busy || undefined}>
              <ObIcon name="user" />
              Sign in with {invite.emailMasked}
            </button>
          </div>
        </div>
      ) : (
        <div style={{ marginTop: 14 }}>
          {problem === "error" ? (
            <p className="ob-err" role="alert">
              We couldn’t accept the invitation. Try again in a moment.
            </p>
          ) : null}
          {signedInAs ? (
            <button type="button" className={`ah-btn ah-btn--primary au-btn-full${busy ? " is-loading" : ""}`} onClick={accept} disabled={busy} aria-busy={busy || undefined}>
              Accept invitation
              <ObIcon name="next" />
            </button>
          ) : (
            <Link className="ah-btn ah-btn--primary au-btn-full" href={inviteAuthPath(token, remembered)}>
              Accept invitation
              <ObIcon name="next" />
            </Link>
          )}
        </div>
      )}
    </InviteShell>
  );
}
