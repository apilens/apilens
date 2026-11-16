"use client";

// Inviting someone new to a project (#809, #753 D4). `InviteToProject` is the "Add people"
// dialog's second step for addresses that match no organization member: the shared chip input
// (member or viewer in the organization, one per address) and the role on this project every
// invitation carries. Addresses the API refuses keep their chip with the reason next to them.
// `PendingInvitations` lists this project's pending invitations under the members table, with who
// sent each, when its link expires, resend (once every 5 minutes, counting down) and revoke.
// Results go to the page's status line, never a toast.
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useId, useState, useTransition } from "react";
import { inviteToProject, resendProjectInvitation, revokeProjectInvitation } from "@/app/[project]/access/invite-actions";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { InviteInput } from "@/components/invite-input";
import { Gated } from "@/components/org-settings/controls";
import type { Invitation, InviteRole, ProjectRole } from "@/lib/identity";
import { type InviteChip, addInviteChips, inviteChipsError, inviteEntries, sendInvitesLabel } from "@/lib/invite-input";
import { formatDay, formatWait, inviterName, isExpired, resendWait } from "@/lib/invitations";
import { ROLE_LABELS } from "@/lib/project-access";
import { PROJECT_INVITE_ORG_ROLES, PROJECT_INVITE_ORG_ROLE_HELP, grantOn } from "@/lib/project-invite";
import { useCan } from "@/lib/permissions";
import { roleLabel } from "@/lib/scope";
import type { Announce } from "./manage";
import { RolePicker } from "./manage";
import "../org-settings/invitations.css";
import "./invite.css";

/** The organization a project belongs to. */
export interface OrgRef {
  slug: string;
  name: string;
}

/** Why someone with `access.manage` but not `members.invite` cannot invite. */
export const INVITE_DENIED = (orgName: string) => `Only organization owners and admins can invite new people to ${orgName}.`;
const COOLDOWN = "An invitation can be emailed once every 5 minutes.";

/**
 * The invite step of "Add people": `emails` are the addresses typed in the search. `onBack`
 * returns to the member list, `onDone` closes the dialog after every address went out.
 */
export function InviteToProject({
  project,
  projectName,
  org,
  emails,
  announce,
  onBack,
  onDone,
  onPending,
}: {
  project: string;
  projectName: string;
  org: OrgRef;
  emails: string[];
  announce: Announce;
  onBack: () => void;
  onDone: () => void;
  onPending: (pending: boolean) => void;
}) {
  const router = useRouter();
  const [orgRole, setOrgRole] = useState<InviteRole>("member");
  const [chips, setChips] = useState<InviteChip[]>(() => addInviteChips([], emails.join(" "), "member"));
  const [draft, setDraft] = useState("");
  const [role, setRole] = useState<ProjectRole>("viewer");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const ids = { emails: useId(), err: useId(), org: useId(), orgHelp: useId() };
  // What would be sent: the chips plus the address still being typed.
  const all = addInviteChips(chips, draft, orgRole);
  const count = all.filter((c) => c.valid && !c.problem).length;

  useEffect(() => onPending(pending), [pending, onPending]);

  const pickOrgRole = (r: InviteRole) => {
    setOrgRole(r);
    setChips((list) => list.map((c) => ({ ...c, role: r })));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    setChips(all);
    setDraft("");
    const problem = inviteChipsError(all);
    if (problem) return setError(problem);
    setError(null);
    start(async () => {
      const result = await inviteToProject(project, org.slug, inviteEntries(all), role, { org: org.name, project: projectName });
      const problems = result.problems ?? {};
      if (result.ok) {
        announce({ tone: "ok", text: result.message });
        router.refresh();
        if (Object.keys(problems).length === 0) return onDone();
      }
      // Keep the refused addresses, each with its reason, so they can be fixed or removed.
      setChips(all.filter((c) => problems[c.email]).map((c) => ({ ...c, problem: problems[c.email] })));
      setError(result.ok ? "Some addresses weren’t invited. Each one says why." : result.error);
    });
  };

  return (
    <form onSubmit={submit} noValidate>
      <p className="om-dialog__p">
        They join {org.name} and get a role on {projectName} when they accept. The link in the email works for 7 days.
      </p>
      <div className="ob-f">
        <label className="ob-l" htmlFor={ids.emails}>
          Email addresses<small>press Enter or comma after each</small>
        </label>
        <InviteInput
          id={ids.emails}
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
          role={orgRole}
          roles={PROJECT_INVITE_ORG_ROLES}
          invalid={error !== null}
          describedBy={error ? ids.err : undefined}
          disabled={pending}
          autoFocus
        />
      </div>
      <div className="ob-f">
        <label className="ob-l" htmlFor={ids.org}>
          Organization role
        </label>
        <select id={ids.org} className="om-select om-select--wide" value={orgRole} disabled={pending} aria-describedby={ids.orgHelp} onChange={(e) => pickOrgRole(e.target.value as InviteRole)}>
          {PROJECT_INVITE_ORG_ROLES.map((r) => (
            <option key={r} value={r}>
              {roleLabel(r)}
            </option>
          ))}
        </select>
        <p className="os-help" id={ids.orgHelp}>
          {PROJECT_INVITE_ORG_ROLE_HELP[orgRole as "member" | "viewer"]}
        </p>
      </div>
      <RolePicker value={role} onChange={setRole} name="am-invite-role" disabled={pending} legend={`Role on ${projectName}`} />
      {error ? (
        <p id={ids.err} className="ob-err" role="alert">
          {error}
        </p>
      ) : null}
      <div className="om-dialog__row">
        <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={onBack} disabled={pending}>
          Back
        </button>
        <button type="submit" className={`ah-btn ah-btn--primary ah-btn--sm${pending ? " is-loading" : ""}`} disabled={pending || all.length === 0}>
          {sendInvitesLabel(count)}
        </button>
      </div>
    </form>
  );
}

/**
 * Pending invitations that carry a role on this project, under the members table. Shown to holders
 * of `access.manage` (the API's rule for the list); resend and revoke also need `members.invite`,
 * otherwise they are disabled with the reason. `invitations` is null when they could not be loaded;
 * `now` is the server's clock at render so the first paint matches, the countdown then follows the
 * browser's.
 */
export function PendingInvitations({
  project,
  projectName,
  org,
  invitations,
  now: renderedAt,
  announce,
}: {
  project: string;
  projectName: string;
  org: OrgRef;
  invitations: Invitation[] | null;
  now: number;
  announce: Announce;
}) {
  const invite = useCan("members.invite");
  const router = useRouter();
  const headingId = useId();
  const [revoking, setRevoking] = useState<Invitation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** Waits the server asked for (`rate_limited`), by invitation id: resend allowed again at. */
  const [retryAt, setRetryAt] = useState<Record<string, number>>({});
  const [now, setNow] = useState(renderedAt);
  const [pending, start] = useTransition();
  const list = invitations ?? [];
  const waitOf = (inv: Invitation) => Math.max(resendWait(inv, now), (retryAt[inv.id] ?? 0) - now);
  const counting = list.some((inv) => waitOf(inv) > 0);

  // A fresh list (after an action) is measured against the current time, not the last tick.
  useEffect(() => setNow(Date.now()), [invitations]);
  useEffect(() => {
    if (!counting) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [counting]);

  const resend = (inv: Invitation) => {
    if (pending) return;
    setBusy(inv.id);
    start(async () => {
      const result = await resendProjectInvitation(project, org.slug, inv.id, inv.email);
      if (!result.ok && result.retryAfter) {
        const until = Date.now() + result.retryAfter * 1000;
        setRetryAt((m) => ({ ...m, [inv.id]: until }));
      }
      setNow(Date.now());
      announce(result.ok ? { tone: "ok", text: result.message } : { tone: "err", text: result.error });
      setBusy(null);
      router.refresh();
    });
  };

  const revoke = () => {
    const inv = revoking;
    if (!inv || pending) return;
    start(async () => {
      const result = await revokeProjectInvitation(project, org.slug, inv.id, inv.email);
      if (result.ok || result.code === "invite_expired") {
        announce(result.ok ? { tone: "ok", text: result.message } : { tone: "err", text: result.error });
        setRevoking(null);
        setError(null);
        router.refresh();
      } else setError(result.error);
    });
  };

  const gate = invite.allowed ? ({ allowed: true } as const) : ({ allowed: false, reason: "Only organization owners and admins can resend or revoke invitations." } as const);

  return (
    <section className="am-inv" aria-labelledby={headingId}>
      <h2 className="am-inv__h" id={headingId}>
        Pending invitations
      </h2>
      {invitations === null ? (
        <p className="os-note am-err" role="alert">
          Couldn’t load the pending invitations to {projectName}. Reload the page to try again.
        </p>
      ) : list.length === 0 ? (
        <p className="am-inv__none">No pending invitations. People you invite to {projectName} from “Add people” show up here until they accept.</p>
      ) : (
        <div className="om-wrap">
          <table className="om-table oi-table am-inv__table">
            <caption className="sr-only">Pending invitations to {projectName}</caption>
            <thead>
              <tr>
                <th scope="col">Email</th>
                <th scope="col">Role on {projectName}</th>
                <th scope="col">Organization role</th>
                <th scope="col">Invited by</th>
                <th scope="col">Expires</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((inv) => {
                const wait = waitOf(inv);
                const grant = grantOn(inv, project);
                return (
                  <tr key={inv.id}>
                    <th scope="row" className="oi-email">
                      {inv.email}
                    </th>
                    <td data-label={`Role on ${projectName}`}>{grant ? <span className={`am-role am-role--${grant}`}>{ROLE_LABELS[grant]}</span> : "—"}</td>
                    <td data-label="Organization role">{roleLabel(inv.role)}</td>
                    <td data-label="Invited by">{inviterName(inv)}</td>
                    <td data-label="Expires">
                      {isExpired(inv, now) ? (
                        <span className="oi-expired">
                          Expired <time dateTime={inv.expires_at}>{formatDay(inv.expires_at)}</time>
                        </span>
                      ) : (
                        <time dateTime={inv.expires_at}>{formatDay(inv.expires_at)}</time>
                      )}
                    </td>
                    <td className="om-act oi-act">
                      <Gated gate={!invite.allowed ? gate : wait > 0 ? { allowed: false, reason: COOLDOWN } : { allowed: true }}>
                        {(describedBy, disabled) => (
                          <button
                            type="button"
                            className={`ah-btn ah-btn--ghost ah-btn--sm oi-resend${busy === inv.id ? " is-loading" : ""}`}
                            onClick={() => resend(inv)}
                            disabled={disabled || pending}
                            aria-label={wait > 0 && invite.allowed ? `Resend invitation to ${inv.email} in ${formatWait(wait)}` : `Resend invitation to ${inv.email}`}
                            aria-describedby={describedBy}
                          >
                            {wait > 0 && invite.allowed ? `Resend in ${formatWait(wait)}` : "Resend"}
                          </button>
                        )}
                      </Gated>
                      <Gated gate={gate}>
                        {(describedBy, disabled) => (
                          <button
                            type="button"
                            className="ah-btn ah-btn--ghost ah-btn--sm om-remove"
                            onClick={() => {
                              setError(null);
                              setRevoking(inv);
                            }}
                            disabled={disabled || pending}
                            aria-label={`Revoke invitation to ${inv.email}`}
                            aria-describedby={describedBy}
                          >
                            Revoke
                          </button>
                        )}
                      </Gated>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmDialog
        open={revoking !== null}
        title="Revoke invitation?"
        actionLabel="Revoke invitation"
        pending={pending}
        error={revoking ? error : null}
        onConfirm={revoke}
        onCancel={() => {
          setRevoking(null);
          setError(null);
        }}
      >
        <p>
          The link sent to {revoking?.email} stops working right away, and the role on {projectName} it carries is dropped. You can invite them again later.
        </p>
      </ConfirmDialog>
    </section>
  );
}
