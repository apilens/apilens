"use client";

import { useState, useTransition } from "react";
import { type SessionsActionResult, revokeSession, signOutOtherSessions } from "@/app/settings/actions";
import type { SessionInfo } from "@/lib/identity";
import { useCanonicalPage } from "@/components/list-search/list-search";
import { Pagination } from "@/components/pagination/pagination";
import { type SearchParams, parsePage, slicePage } from "@/lib/pagination";
import { SESSIONS_PATH, deviceLabel, formatDateTime, hasOtherSessions, lastActive, orderSessions, signInMethod } from "@/lib/sessions";
import "./sessions.css";

type Status = { tone: "ok" | "err"; text: string } | null;

const plural = (n: number) => `${n} other session${n === 1 ? "" : "s"}`;

/**
 * `/settings/sessions` (#343): every device signed in to the account, the current one pinned
 * first with a badge and the rest newest first. Each row can be revoked; revoking the current one
 * signs this browser out. The rows come from the server: after an action the page is
 * revalidated and re-rendered with the new list. The API returns every session, so they are paged
 * here (`?page=&per=`, `search` is the page's searchParams); the current one leads page 1.
 */
export function SessionsSettings({ sessions, now, search = {} }: { sessions: SessionInfo[]; now: number; search?: SearchParams }) {
  const ordered = orderSessions(sessions);
  const others = hasOtherSessions(ordered);
  const { rows, window } = slicePage(ordered, parsePage(search));
  useCanonicalPage(SESSIONS_PATH, search, window);
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run = (key: string, action: () => Promise<SessionsActionResult>, done: (r: { revoked: number }) => string) => {
    if (pending) return;
    setBusy(key);
    setStatus(null);
    start(async () => {
      const result = await action();
      setStatus(result.ok ? { tone: "ok", text: done(result) } : { tone: "err", text: result.error });
      setBusy(null);
    });
  };

  const revoke = (s: SessionInfo) => run(s.id, () => revokeSession(s.id), () => `Signed out ${deviceLabel(s)}.`);
  const revokeOthers = () =>
    run("others", signOutOtherSessions, ({ revoked }) => (revoked > 0 ? `Signed out ${plural(revoked)}.` : "No other sessions were signed in."));

  return (
    <div className="ss">
      <div className="ss-bar">
        <p className="ss-count">
          {ordered.length === 1 ? "1 active session" : `${ordered.length.toLocaleString("en-US")} active sessions`}
        </p>
        <span className={`ss-status${status ? ` ${status.tone}` : ""}`} role="status" aria-live="polite">
          {status?.text ?? ""}
        </span>
        <button
          type="button"
          className={`ah-btn ah-btn--secondary ah-btn--sm${busy === "others" ? " is-loading" : ""}`}
          onClick={revokeOthers}
          disabled={!others || pending}
          aria-describedby={others ? undefined : "ss-none"}
        >
          Sign out other sessions
        </button>
      </div>

      {ordered.length === 0 ? (
        <p className="ss-empty">No active sessions.</p>
      ) : (
        <div className="ss-wrap">
          <table className="ss-table">
            <caption className="sr-only">Sessions signed in to your account, current first</caption>
            <thead>
              <tr>
                <th scope="col">Device</th>
                <th scope="col">IP address</th>
                <th scope="col">Last active</th>
                <th scope="col">Signed in</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const device = deviceLabel(s);
                const method = signInMethod(s.amr);
                return (
                  <tr key={s.id} className={s.current ? "current" : undefined} aria-current={s.current ? "true" : undefined}>
                    <th scope="row" className="ss-device">
                      <span className="ss-device__name">
                        <span title={s.user_agent || undefined}>{device}</span>
                        {s.current ? <span className="ss-badge">This device</span> : null}
                      </span>
                      {method ? <span className="ss-sub">{method}</span> : null}
                    </th>
                    <td data-label="IP address" className="ss-mono">
                      {s.ip ?? <span className="ss-muted">Unknown</span>}
                    </td>
                    <td data-label="Last active">
                      <time dateTime={s.last_seen_at} title={formatDateTime(s.last_seen_at)}>
                        {lastActive(s.last_seen_at, now)}
                      </time>
                    </td>
                    <td data-label="Signed in">
                      <time dateTime={s.created_at}>{formatDateTime(s.created_at)}</time>
                    </td>
                    <td className="ss-act">
                      <button
                        type="button"
                        className={`ah-btn ah-btn--ghost ah-btn--sm ss-revoke${busy === s.id ? " is-loading" : ""}`}
                        onClick={() => revoke(s)}
                        disabled={pending}
                        aria-label={s.current ? `Revoke ${device} (this device) and sign out` : `Revoke ${device}`}
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <Pagination pathname={SESSIONS_PATH} params={search} total={window.total} label="Sessions pages" className="ss-pages" />
        </div>
      )}
      {others ? null : (
        <p id="ss-none" className="ss-note">
          This is the only device signed in to your account.
        </p>
      )}
      <p className="ss-note">Revoking this device signs you out here too.</p>
    </div>
  );
}
