"use client";

import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState, useTransition } from "react";
import { type MembersActionResult, changeMemberRole, inviteMembers, removeMember, transferOwnership } from "@/app/orgs/[org]/settings/members/actions";
import type { InviteRole, Member, OrgRole } from "@/lib/identity";
import {
  type Gate,
  INVITE_ROLES,
  MAX_INVITES,
  MEMBER_ROLES,
  ROLE_SUMMARY,
  type Viewer,
  formatJoined,
  inviteGate,
  memberInitials,
  memberName,
  ownerCount,
  parseInviteEmails,
  removeGate,
  roleGate,
  roleOptionAllowed,
  transferCandidates,
  transferGate,
} from "@/lib/org-members";
import { roleLabel } from "@/lib/scope";
import { OrgSettingsNav } from "./nav";
import "./org-settings.css";
import "./members.css";

type Status = { tone: "ok" | "err"; text: string } | null;
type OrgRef = { slug: string; name: string };

const statusOf = (r: MembersActionResult): Status => (r.ok ? { tone: "ok", text: r.message } : { tone: "err", text: r.error });

/**
 * A control that may be disabled: when `gate` denies it, the control is wrapped so hovering or
 * focusing it shows the reason, and the reason is the control's accessible description.
 * `children` receives the description id (undefined when allowed) and whether it is disabled.
 */
function Gated({ gate, children }: { gate: Gate; children: (describedBy: string | undefined, disabled: boolean) => ReactNode }) {
  const id = useId();
  if (gate.allowed) return <>{children(undefined, false)}</>;
  return (
    // Focusable so keyboard users reach the reason of a control they cannot use.
    <span className="om-gate" tabIndex={0}>
      {children(id, true)}
      <span id={id} role="tooltip" className="om-tip">
        {gate.reason}
      </span>
    </span>
  );
}

/** A modal `<dialog>`: Esc and a click on the backdrop close it. */
function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="om-dialog"
      aria-labelledby={titleId}
      onClose={onClose}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {open ? (
        <div className="om-dialog__in">
          <h2 id={titleId}>{title}</h2>
          {children}
        </div>
      ) : null}
    </dialog>
  );
}

/**
 * `/orgs/<org>/settings/members` (#345): everyone in the organization with their role and when
 * they joined. Owners and admins (`members.remove`) change roles and remove members; owners
 * transfer ownership; `members.invite` opens the invite dialog. Controls the user cannot use stay
 * visible, disabled, with the reason on hover and focus. The rows come from the server: after an
 * action the page is revalidated and re-rendered with the new list.
 */
export function OrgMembersSettings({ org, members, viewer }: { org: OrgRef; members: Member[]; viewer: Viewer }) {
  const owners = ownerCount(members);
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingRole, setPendingRole] = useState<{ id: string; role: OrgRole } | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [transferring, setTransferring] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [pending, start] = useTransition();

  const changeRole = (m: Member, role: OrgRole) => {
    if (pending || role === m.role) return;
    setBusy(`role:${m.user.id}`);
    setPendingRole({ id: m.user.id, role });
    setStatus(null);
    start(async () => {
      setStatus(statusOf(await changeMemberRole(org.slug, m.user.id, role, memberName(m))));
      setPendingRole(null);
      setBusy(null);
    });
  };

  const invite = inviteGate(viewer);
  const transfer = transferGate(viewer, members);

  return (
    <div className="os om">
      <header className="os-head">
        <p className="cp-h">Organization</p>
        <h1 className="cp-lede">Members</h1>
        <OrgSettingsNav org={org.slug} current="members" />
      </header>

      <div className="om-bar">
        <p className="om-count">{members.length === 1 ? "1 member" : `${members.length} members`}</p>
        <span className={`om-status${status ? ` ${status.tone}` : ""}`} role="status" aria-live="polite">
          {status?.text ?? ""}
        </span>
        <Gated gate={transfer}>
          {(describedBy, disabled) => (
            <button type="button" className="ah-btn ah-btn--secondary ah-btn--sm" onClick={() => setTransferring(true)} disabled={disabled || pending} aria-describedby={describedBy}>
              Transfer ownership
            </button>
          )}
        </Gated>
        <Gated gate={invite}>
          {(describedBy, disabled) => (
            <button type="button" className="ah-btn ah-btn--primary ah-btn--sm" onClick={() => setInviting(true)} disabled={disabled || pending} aria-describedby={describedBy}>
              Invite people
            </button>
          )}
        </Gated>
      </div>

      <div className="om-wrap">
        <table className="om-table">
          <caption className="sr-only">Members of {org.name}</caption>
          <thead>
            <tr>
              <th scope="col">Member</th>
              <th scope="col">Role</th>
              <th scope="col">Joined</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const name = memberName(m);
              const self = m.user.id === viewer.id;
              const role = roleGate(viewer, m, owners);
              const remove = removeGate(viewer, m, owners);
              const shown = pendingRole?.id === m.user.id ? pendingRole.role : m.role;
              return (
                <tr key={m.user.id} aria-current={self ? "true" : undefined}>
                  <th scope="row" className="om-who">
                    <span className="cp-av" aria-hidden="true">
                      {memberInitials(m)}
                    </span>
                    <span className="om-who__t">
                      <span className="om-name">
                        {name}
                        {self ? <span className="om-you">You</span> : null}
                      </span>
                      {name !== m.user.email ? <span className="om-email">{m.user.email}</span> : null}
                    </span>
                  </th>
                  <td data-label="Role">
                    <Gated gate={role}>
                      {(describedBy, disabled) => (
                        <select
                          className={`om-select${busy === `role:${m.user.id}` ? " is-busy" : ""}`}
                          value={shown}
                          disabled={disabled || pending}
                          onChange={(e) => changeRole(m, e.target.value as OrgRole)}
                          aria-label={`Role of ${name}`}
                          aria-describedby={describedBy}
                        >
                          {MEMBER_ROLES.map((r) => (
                            <option key={r} value={r} disabled={r !== m.role && !roleOptionAllowed(viewer, r)}>
                              {roleLabel(r)}
                            </option>
                          ))}
                        </select>
                      )}
                    </Gated>
                  </td>
                  <td data-label="Joined">
                    <time dateTime={m.joined_at}>{formatJoined(m.joined_at)}</time>
                  </td>
                  <td className="om-act">
                    <Gated gate={remove}>
                      {(describedBy, disabled) => (
                        <button
                          type="button"
                          className="ah-btn ah-btn--ghost ah-btn--sm om-remove"
                          onClick={() => setRemoving(m)}
                          disabled={disabled || pending}
                          aria-label={`Remove ${name}`}
                          aria-describedby={describedBy}
                        >
                          Remove
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

      <dl className="om-roles">
        {MEMBER_ROLES.map((r) => (
          <div key={r}>
            <dt>{roleLabel(r)}</dt>
            <dd>{ROLE_SUMMARY[r]}</dd>
          </div>
        ))}
      </dl>

      <RemoveDialog org={org} member={removing} onClose={() => setRemoving(null)} onDone={setStatus} />
      {viewer.role === "owner" ? (
        <TransferDialog org={org} open={transferring} candidates={transferCandidates(viewer, members)} onClose={() => setTransferring(false)} onDone={setStatus} />
      ) : null}
      {viewer.invite ? <InviteDialog org={org} open={inviting} onClose={() => setInviting(false)} onDone={setStatus} /> : null}
    </div>
  );
}

function DialogError({ error, id }: { error: string | null; id: string }) {
  return error ? (
    <p id={id} className="ob-err" role="alert">
      {error}
    </p>
  ) : null;
}

function RemoveDialog({ org, member, onClose, onDone }: { org: OrgRef; member: Member | null; onClose: () => void; onDone: (s: Status) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const name = member ? memberName(member) : "";
  const close = () => {
    setError(null);
    onClose();
  };
  const confirm = () => {
    if (!member || pending) return;
    start(async () => {
      const result = await removeMember(org.slug, member.user.id, name);
      if (result.ok || result.code === "member_gone") {
        onDone(statusOf(result));
        close();
      } else setError(result.error);
    });
  };
  return (
    <Modal open={member !== null} onClose={close} title={`Remove ${name}?`}>
      <p className="om-dialog__p">
        {name} loses access to {org.name} and its projects right away. You can invite them again later.
      </p>
      <DialogError error={error} id="om-remove-err" />
      <div className="om-dialog__row">
        <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={close} disabled={pending}>
          Cancel
        </button>
        <button type="button" className={`ah-btn ah-btn--sm os-btn-danger${pending ? " is-loading" : ""}`} onClick={confirm} disabled={pending} autoFocus>
          Remove member
        </button>
      </div>
    </Modal>
  );
}

function TransferDialog({ org, open, candidates, onClose, onDone }: { org: OrgRef; open: boolean; candidates: Member[]; onClose: () => void; onDone: (s: Status) => void }) {
  const [to, setTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const chosen = candidates.find((m) => m.user.id === to);
  const close = () => {
    setTo("");
    setError(null);
    onClose();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!chosen || pending) return;
    start(async () => {
      const result = await transferOwnership(org.slug, chosen.user.id, memberName(chosen));
      if (result.ok) {
        onDone(statusOf(result));
        close();
      } else setError(result.error);
    });
  };
  return (
    <Modal open={open} onClose={close} title="Transfer ownership">
      <form onSubmit={submit}>
        <p className="om-dialog__p">
          The person you choose becomes an owner of {org.name}. You become an admin and can no longer delete the organization or transfer it again.
        </p>
        <div className="ob-f">
          <label className="ob-l" htmlFor="om-transfer-to">
            New owner
          </label>
          <select id="om-transfer-to" className="om-select om-select--wide" value={to} onChange={(e) => { setTo(e.target.value); setError(null); }} aria-describedby={error ? "om-transfer-err" : undefined}>
            <option value="">Choose a member</option>
            {candidates.map((m) => (
              <option key={m.user.id} value={m.user.id}>
                {memberName(m)} · {roleLabel(m.role)}
              </option>
            ))}
          </select>
        </div>
        <DialogError error={error} id="om-transfer-err" />
        <div className="om-dialog__row">
          <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={close} disabled={pending}>
            Cancel
          </button>
          <button type="submit" className={`ah-btn ah-btn--sm os-btn-danger${pending ? " is-loading" : ""}`} disabled={!chosen || pending}>
            Transfer ownership
          </button>
        </div>
      </form>
    </Modal>
  );
}

function InviteDialog({ org, open, onClose, onDone }: { org: OrgRef; open: boolean; onClose: () => void; onDone: (s: Status) => void }) {
  const [text, setText] = useState("");
  const [role, setRole] = useState<InviteRole>("member");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const parsed = parseInviteEmails(text);
  const close = () => {
    setText("");
    setRole("member");
    setError(null);
    onClose();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    if (parsed.invalid.length > 0) return setError(`“${parsed.invalid[0]}” isn’t an email address.`);
    if (parsed.emails.length === 0) return setError("Enter at least one email address.");
    if (parsed.emails.length > MAX_INVITES) return setError(`Invite at most ${MAX_INVITES} people at a time.`);
    start(async () => {
      const result = await inviteMembers(org.slug, parsed.emails, role);
      if (result.ok) {
        onDone(statusOf(result));
        close();
      } else setError(result.error);
    });
  };
  return (
    <Modal open={open} onClose={close} title={`Invite people to ${org.name}`}>
      <form onSubmit={submit}>
        <div className="ob-f">
          <label className="ob-l" htmlFor="om-invite-emails">
            Email addresses<small>separate with commas or new lines</small>
          </label>
          <textarea
            id="om-invite-emails"
            className="om-textarea"
            rows={3}
            value={text}
            placeholder="ada@example.com, grace@example.com"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
            aria-invalid={error !== null}
            aria-describedby={error ? "om-invite-err" : undefined}
          />
        </div>
        <div className="ob-f">
          <label className="ob-l" htmlFor="om-invite-role">
            Role
          </label>
          <select id="om-invite-role" className="om-select om-select--wide" value={role} onChange={(e) => setRole(e.target.value as InviteRole)}>
            {INVITE_ROLES.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </select>
          <p className="os-help">{ROLE_SUMMARY[role]}</p>
        </div>
        <DialogError error={error} id="om-invite-err" />
        <div className="om-dialog__row">
          <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={close} disabled={pending}>
            Cancel
          </button>
          <button type="submit" className={`ah-btn ah-btn--primary ah-btn--sm${pending ? " is-loading" : ""}`} disabled={pending || parsed.emails.length === 0}>
            {parsed.emails.length > 1 ? `Send ${parsed.emails.length} invitations` : "Send invitation"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
