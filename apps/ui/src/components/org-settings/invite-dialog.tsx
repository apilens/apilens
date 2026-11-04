"use client";

// The invite dialog of the organization members and invitations pages (#345, #346): the shared
// chip input (one role per address) and a role for the addresses added next.
import { type FormEvent, useState, useTransition } from "react";
import { inviteMembers } from "@/app/orgs/[org]/settings/members/actions";
import { InviteInput } from "@/components/invite-input";
import type { InviteRole } from "@/lib/identity";
import { INVITE_ROLES, type InviteChip, addInviteChips, inviteChipsError, inviteEntries, sendInvitesLabel } from "@/lib/invite-input";
import { ROLE_SUMMARY } from "@/lib/org-members";
import { roleLabel } from "@/lib/scope";
import { DialogError, Modal, type OrgRef, type Status, statusOf } from "./controls";

export function InviteDialog({ org, open, onClose, onDone }: { org: OrgRef; open: boolean; onClose: () => void; onDone: (s: Status) => void }) {
  const [chips, setChips] = useState<InviteChip[]>([]);
  const [draft, setDraft] = useState("");
  const [role, setRole] = useState<InviteRole>("member");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // What would be sent: the chips plus the address still being typed.
  const all = addInviteChips(chips, draft, role);
  const count = all.filter((c) => c.valid).length;

  const close = () => {
    setChips([]);
    setDraft("");
    setRole("member");
    setError(null);
    onClose();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    setChips(all);
    setDraft("");
    const problem = inviteChipsError(all);
    if (problem) return setError(problem);
    start(async () => {
      const result = await inviteMembers(org.slug, inviteEntries(all));
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
            Email addresses<small>press Enter or comma after each</small>
          </label>
          <InviteInput
            id="om-invite-emails"
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
            describedBy={error ? "om-invite-err" : undefined}
            disabled={pending}
            autoFocus
          />
        </div>
        <div className="ob-f">
          <label className="ob-l" htmlFor="om-invite-role">
            Default role<small>for addresses you add next</small>
          </label>
          <select id="om-invite-role" className="om-select om-select--wide" value={role} onChange={(e) => setRole(e.target.value as InviteRole)}>
            {INVITE_ROLES.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </select>
          <p className="os-help">{ROLE_SUMMARY[role]} Change one person’s role on their chip.</p>
        </div>
        <DialogError error={error} id="om-invite-err" />
        <div className="om-dialog__row">
          <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={close} disabled={pending}>
            Cancel
          </button>
          <button type="submit" className={`ah-btn ah-btn--primary ah-btn--sm${pending ? " is-loading" : ""}`} disabled={pending || all.length === 0}>
            {sendInvitesLabel(count)}
          </button>
        </div>
      </form>
    </Modal>
  );
}
