"use client";

import { type FormEvent, useState, useTransition } from "react";
import { changeMemberRole, removeMember, transferOwnership } from "@/app/orgs/[org]/settings/members/actions";
import type { Member, OrgRole } from "@/lib/identity";
import {
  MEMBER_ROLES,
  ROLE_SUMMARY,
  type Viewer,
  formatJoined,
  inviteGate,
  memberInitials,
  memberName,
  ownerCount,
  removeGate,
  roleGate,
  roleOptionAllowed,
  transferCandidates,
  transferGate,
} from "@/lib/org-members";
import { roleLabel } from "@/lib/scope";
import { DialogError, Gated, Modal, type OrgRef, type Status, statusOf } from "./controls";
import { InviteDialog } from "./invite-dialog";
import { OrgSettingsNav } from "./nav";
import "./org-settings.css";
import "./members.css";

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
