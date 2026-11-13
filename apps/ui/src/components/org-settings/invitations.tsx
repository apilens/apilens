"use client";

import { useEffect, useState, useTransition } from "react";
import { resendInvitation, revokeInvitation } from "@/app/orgs/[org]/settings/invitations/actions";
import type { Invitation, OrgRole } from "@/lib/identity";
import { formatDay, formatWait, inviterName, isExpired, resendWait } from "@/lib/invitations";
import { roleLabel } from "@/lib/scope";
import { ListSearch, useCanonicalPage, useListSearch } from "@/components/list-search/list-search";
import { Pagination } from "@/components/pagination/pagination";
import { countLine, searchRows } from "@/lib/list-search";
import { type SearchParams, parsePage, slicePage } from "@/lib/pagination";
import { DialogError, Gated, Modal, type OrgRef, type Status, statusOf } from "./controls";
import { InviteDialog } from "./invite-dialog";
import { OrgSettingsNav } from "./nav";
import "./org-settings.css";
import "./members.css";
import "./invitations.css";

const NO_ACCESS = "Only owners and admins can invite people.";
const COOLDOWN = "An invitation can be emailed once every 5 minutes.";

/**
 * `/orgs/<org>/settings/invitations` (#346): the organization's pending invitations (email,
 * role, who sent it, when the link expires), newest first. Owners and admins resend one (at most
 * once every 5 minutes; the button counts down) or revoke it, and invite more people with the
 * shared invite dialog. Others see why the list is hidden. The rows come from the server: after
 * an action the page is revalidated and re-rendered with the new list. `now` is the server's
 * clock at render, so the first paint matches; the countdown then follows the browser's.
 * The API returns every pending invitation, so the list is searched (email, role, who sent it) and
 * paged here; revoking the last one of the last page lands on the new last page.
 */
export function OrgInvitationsSettings({
  org,
  role,
  invitations: all,
  manage,
  now: renderedAt,
  search = {},
}: {
  org: OrgRef;
  /** The signed-in user's role in the organization (which settings tabs they see). */
  role: OrgRole;
  invitations: Invitation[];
  manage: boolean;
  now: number;
  /** The page's searchParams: the list is searched (`?q=`) and paged (`?page=&per=`) here. */
  search?: SearchParams;
}) {
  const pathname = `/orgs/${org.slug}/settings/invitations`;
  const list = useListSearch(pathname, search);
  const matched = searchRows(all, list.query, (inv) => [inv.email, roleLabel(inv.role), inviterName(inv)]);
  const { rows: invitations, window } = slicePage(matched, parsePage(list.params));
  useCanonicalPage(pathname, search, list.settled ? window : null);
  const [status, setStatus] = useState<Status>(null);
  const [revoking, setRevoking] = useState<Invitation | null>(null);
  const [inviting, setInviting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  /** Waits the server asked for (`rate_limited`), by invitation id: resend allowed again at. */
  const [retryAt, setRetryAt] = useState<Record<string, number>>({});
  const [now, setNow] = useState(renderedAt);
  const [pending, start] = useTransition();

  const waitOf = (inv: Invitation) => Math.max(resendWait(inv, now), (retryAt[inv.id] ?? 0) - now);
  const counting = invitations.some((inv) => waitOf(inv) > 0);

  // A fresh list (after an action) is measured against the current time, not the last tick.
  useEffect(() => setNow(Date.now()), [all]);
  useEffect(() => {
    if (!counting) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [counting]);

  const resend = (inv: Invitation) => {
    if (pending) return;
    setBusy(inv.id);
    setStatus(null);
    start(async () => {
      const result = await resendInvitation(org.slug, inv.id, inv.email);
      if (!result.ok && result.retryAfter) {
        const until = Date.now() + result.retryAfter * 1000;
        setRetryAt((m) => ({ ...m, [inv.id]: until }));
      }
      setNow(Date.now());
      setStatus(statusOf(result));
      setBusy(null);
    });
  };

  const gate = manage ? ({ allowed: true } as const) : ({ allowed: false, reason: NO_ACCESS } as const);

  return (
    <div className="page os om">
      <header className="os-head">
        <p className="cp-h">Organization</p>
        <h1 className="cp-lede">Invitations</h1>
        <OrgSettingsNav org={org.slug} current="invitations" role={role} />
      </header>

      <div className="om-bar">
        <p className="om-count">{!manage ? "Pending invitations" : countLine(matched.length, all.length, "pending invitation", "pending invitations", list.query)}</p>
        {manage && all.length > 0 ? (
          <ListSearch value={list.query} onChange={list.setQuery} label="Search invitations" placeholder="Search by email, role or sender" controls="oi-list" />
        ) : null}
        <span className={`om-status${status ? ` ${status.tone}` : ""}`} role="status" aria-live="polite">
          {status?.text ?? ""}
        </span>
        <Gated gate={gate}>
          {(describedBy, disabled) => (
            <button type="button" className="ah-btn ah-btn--primary ah-btn--sm" onClick={() => setInviting(true)} disabled={disabled || pending} aria-describedby={describedBy}>
              Invite people
            </button>
          )}
        </Gated>
      </div>

      {!manage ? (
        <div className="om-wrap oi-empty">
          <p className="oi-empty__t">Only owners and admins can see invitations</p>
          <p className="oi-empty__p">Ask an owner or admin of {org.name} to invite someone or to resend an invitation.</p>
        </div>
      ) : all.length === 0 ? (
        <div className="om-wrap oi-empty">
          <p className="oi-empty__t">No pending invitations</p>
          <p className="oi-empty__p">People you invite show up here until they accept. You can resend or revoke an invitation from this list.</p>
          <button type="button" className="ah-btn ah-btn--secondary ah-btn--sm oi-empty__btn" onClick={() => setInviting(true)} disabled={pending}>
            Invite people
          </button>
        </div>
      ) : matched.length === 0 ? (
        <div className="om-wrap ls-none" id="oi-list">
          <p className="ls-none__t">No invitations match “{list.query.trim()}”</p>
          <p className="ls-none__p">Search looks at email addresses, roles and who sent the invitation.</p>
          <button type="button" className="ah-btn ah-btn--secondary ah-btn--sm" onClick={() => list.setQuery("")}>
            Clear search
          </button>
        </div>
      ) : (
        <div className="om-wrap">
          <table className="om-table oi-table" id="oi-list">
            <caption className="sr-only">Pending invitations to {org.name}</caption>
            <thead>
              <tr>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col">Invited by</th>
                <th scope="col">Expires</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {invitations.map((inv) => {
                const wait = waitOf(inv);
                const expired = isExpired(inv, now);
                return (
                  <tr key={inv.id}>
                    <th scope="row" className="oi-email">
                      {inv.email}
                    </th>
                    <td data-label="Role">{roleLabel(inv.role)}</td>
                    <td data-label="Invited by">{inviterName(inv)}</td>
                    <td data-label="Expires">
                      {expired ? (
                        <span className="oi-expired">
                          Expired <time dateTime={inv.expires_at}>{formatDay(inv.expires_at)}</time>
                        </span>
                      ) : (
                        <time dateTime={inv.expires_at}>{formatDay(inv.expires_at)}</time>
                      )}
                    </td>
                    <td className="om-act oi-act">
                      <Gated gate={wait > 0 ? { allowed: false, reason: COOLDOWN } : { allowed: true }}>
                        {(describedBy) => (
                          <button
                            type="button"
                            className={`ah-btn ah-btn--ghost ah-btn--sm oi-resend${busy === inv.id ? " is-loading" : ""}`}
                            onClick={() => resend(inv)}
                            disabled={wait > 0 || pending}
                            aria-label={wait > 0 ? `Resend invitation to ${inv.email} in ${formatWait(wait)}` : `Resend invitation to ${inv.email}`}
                            aria-describedby={describedBy}
                          >
                            {wait > 0 ? `Resend in ${formatWait(wait)}` : "Resend"}
                          </button>
                        )}
                      </Gated>
                      <button
                        type="button"
                        className="ah-btn ah-btn--ghost ah-btn--sm om-remove"
                        onClick={() => setRevoking(inv)}
                        disabled={pending}
                        aria-label={`Revoke invitation to ${inv.email}`}
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <Pagination pathname={pathname} params={list.params} total={window.total} label="Invitations pages" className="ls-pages" />
        </div>
      )}

      {manage ? (
        <>
          <RevokeDialog org={org} invitation={revoking} onClose={() => setRevoking(null)} onDone={setStatus} />
          <InviteDialog org={org} open={inviting} onClose={() => setInviting(false)} onDone={setStatus} />
        </>
      ) : null}
    </div>
  );
}

function RevokeDialog({ org, invitation, onClose, onDone }: { org: OrgRef; invitation: Invitation | null; onClose: () => void; onDone: (s: Status) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const close = () => {
    setError(null);
    onClose();
  };
  const confirm = () => {
    if (!invitation || pending) return;
    start(async () => {
      const result = await revokeInvitation(org.slug, invitation.id, invitation.email);
      if (result.ok || result.code === "invite_expired") {
        onDone(statusOf(result));
        close();
      } else setError(result.error);
    });
  };
  return (
    <Modal open={invitation !== null} onClose={close} title="Revoke invitation?">
      <p className="om-dialog__p">
        The link sent to {invitation?.email} stops working right away. You can invite them to {org.name} again later.
      </p>
      <DialogError error={error} id="oi-revoke-err" />
      <div className="om-dialog__row">
        <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={close} disabled={pending}>
          Cancel
        </button>
        <button type="button" className={`ah-btn ah-btn--sm os-btn-danger${pending ? " is-loading" : ""}`} onClick={confirm} disabled={pending} autoFocus>
          Revoke invitation
        </button>
      </div>
    </Modal>
  );
}
