"use client";

import { unstable_rethrow } from "next/navigation";
import { type FormEvent, useState, useTransition } from "react";
import { openProject } from "@/app/(auth)/onboarding/first-data/actions";
import { inviteTeam } from "@/app/(auth)/onboarding/invite/actions";
import { InviteInput } from "@/components/invite-input";
import type { InviteResult, InviteRole } from "@/lib/identity";
import { type InviteChip, addInviteChips, inviteChipsError, inviteEntries, sendInvitesLabel } from "@/lib/invite-input";
import { TOGGLE_ROLES, inviteError, inviteOutcomes, outcomeTitle, sentCount } from "@/lib/onboarding-invite";
import { ROLE_SUMMARY } from "@/lib/org-members";
import { roleLabel } from "@/lib/scope";
import { ObIcon, ObShell, type StepProps, describedBy } from "./ob";
import { useOnboardingToast } from "./progress";
import "./invite-team.css";

const FORM = "invite-team-form";
const OPEN_FAILED = "We couldn’t finish setup. Try again in a moment.";

/**
 * "Invite your team" (#336), the last onboarding screen. The shared chip input turns typed or
 * pasted addresses into chips (split on commas, spaces and new lines; each checked, invalid ones
 * red); the Member/Viewer toggle sets the role of addresses added next, and each chip's own select
 * changes one person's role, Admin included. "Send N invitations" posts them all at once and
 * lists the result per address (sent, already a member, listed twice). "Open project" (or "Skip
 * for now") finishes onboarding and opens the project.
 */
export function InviteTeamScreen({
  step = 4,
  reached = step,
  org,
  project,
  canInvite,
  invited: savedInvited = 0,
}: Partial<StepProps> & {
  org: { slug: string; name: string };
  project: { slug: string; name: string };
  /** Whether the user may invite (owners and admins); others only see the way out. */
  canInvite: boolean;
  /** How many invitations onboarding has sent so far (the saved `invited` answer). */
  invited?: number;
}) {
  const [chips, setChips] = useState<InviteChip[]>([]);
  const [draft, setDraft] = useState("");
  const [role, setRole] = useState<InviteRole>("member");
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<InviteResult[] | null>(null);
  const [invited, setInvited] = useState(savedInvited);
  const [sending, startSending] = useTransition();
  const [opening, startOpening] = useTransition();
  const toast = useOnboardingToast();
  const busy = sending || opening;

  // What would be sent: the chips plus the address still being typed.
  const all = addInviteChips(chips, draft, role);
  const count = all.filter((c) => c.valid).length;

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    setChips(all);
    setDraft("");
    const problem = inviteChipsError(all);
    if (problem) return setError(problem);
    setError(null);
    startSending(async () => {
      try {
        const res = await inviteTeam(org.slug, inviteEntries(all));
        if (!res.ok) return setError(res.error);
        setResults(res.results);
        setInvited((n) => n + sentCount(res.results));
        setChips([]);
      } catch (err) {
        unstable_rethrow(err);
        setError(inviteError("unavailable"));
      }
    });
  };

  const finish = () =>
    startOpening(async () => {
      try {
        const res = await openProject(project.slug);
        if (!res.ok) toast(res.error);
      } catch (err) {
        unstable_rethrow(err);
        toast(OPEN_FAILED);
      }
    });

  const inviteMore = () => {
    setResults(null);
    setError(null);
  };

  const footer = (
    <div className="ob-foot">
      {results || !canInvite ? (
        <>
          <span className="sp" />
          {results && canInvite ? (
            <button type="button" className="ah-btn ah-btn--secondary" onClick={inviteMore} disabled={busy}>
              <ObIcon name="mail" />
              Invite more
            </button>
          ) : null}
          <button type="button" className={`ah-btn ah-btn--primary${opening ? " is-loading" : ""}`} onClick={finish} disabled={busy} aria-busy={opening || undefined}>
            Open project
            <ObIcon name="next" />
          </button>
        </>
      ) : (
        <>
          <button type="button" className={`ah-btn ah-btn--ghost${opening ? " is-loading" : ""}`} onClick={finish} disabled={busy} aria-busy={opening || undefined}>
            Skip for now
          </button>
          <span className="sp" />
          <button
            type="submit"
            form={FORM}
            className={`ah-btn ah-btn--primary${sending ? " is-loading" : ""}`}
            disabled={busy || all.length === 0}
            aria-busy={sending || undefined}
          >
            <ObIcon name="mail" />
            {sendInvitesLabel(count)}
          </button>
        </>
      )}
    </div>
  );

  return (
    <ObShell
      eyebrow="02:46 AM"
      headline={["Nobody should", "debug alone", "at 2 AM."]}
      body="Invite the people who get paged with you. They see the same requests, traces and errors, and join with one click from the email."
      receipt={
        <>
          team · <b>{org.name}</b> · {invited === 1 ? "1 invited" : `${invited} invited`}
        </>
      }
      progress={100}
      step={step}
      reached={reached}
      badge="team"
      title="Invite your team"
      lead={
        <>
          Bring your teammates into <b>{org.name}</b>. They’ll land in <b>{project.name}</b>.
        </>
      }
      footer={footer}
    >
      {!canInvite ? (
        <div className="ob-notice it-notice" role="status">
          <ObIcon name="info" />
          <p>
            Only owners and admins of <b>{org.name}</b> can invite people. Ask one of them to invite your team.
          </p>
        </div>
      ) : results ? (
        <section className="ob-f it-results" aria-labelledby="it-results-h">
          <div className="ob-l">
            <h2 className="it-h" id="it-results-h">
              {outcomeTitle(results)}
            </h2>
            <small>links work for 7 days</small>
          </div>
          <ul className="ob-inv it-list" aria-labelledby="it-results-h">
            {inviteOutcomes(results).map((r, i) => (
              <li key={`${r.email}-${i}`} className="row">
                <span className="cp-av" aria-hidden="true">
                  {(r.email[0] ?? "?").toUpperCase()}
                </span>
                <b className="it-email">{r.email}</b>
                <span className={`it-status it-${r.tone}`}>
                  {r.tone === "ok" ? <ObIcon name="done" /> : <ObIcon name="info" />}
                  {r.label}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <form id={FORM} onSubmit={submit} noValidate>
          <div className="ob-f">
            <label className="ob-l" htmlFor="it-emails">
              Email addresses<small>comma, space or new line between them</small>
            </label>
            <InviteInput
              id="it-emails"
              chips={chips}
              onChange={(next) => {
                setChips(next);
                setError(null);
              }}
              draft={draft}
              onDraftChange={(d) => {
                setDraft(d);
                setError(null);
              }}
              role={role}
              invalid={error !== null}
              describedBy={describedBy(error && "it-err", "it-role-help")}
              disabled={sending}
              autoFocus
              placeholder="ada@example.com, grace@example.com"
            />
            {error ? (
              <p id="it-err" className="ob-err" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <fieldset className="ob-f it-role">
            <legend className="ob-l">
              Role<small>for addresses you add next</small>
            </legend>
            <div className="ob-seg it-seg">
              {TOGGLE_ROLES.map((r) => (
                <label key={r} className={role === r ? "on" : undefined}>
                  <input type="radio" name="it-role" value={r} checked={role === r} onChange={() => setRole(r)} disabled={sending} />
                  <span>{roleLabel(r)}</span>
                </label>
              ))}
            </div>
            <p className="ob-note" id="it-role-help">
              <ObIcon name="info" />
              <span>
                {ROLE_SUMMARY[role]} Change one person’s role on their address, <b>Admin</b> included.
              </span>
            </p>
          </fieldset>
        </form>
      )}
    </ObShell>
  );
}
