"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { connectAccount, disconnectAccount } from "@/app/settings/_connected-accounts/actions";
import {
  type ConnectedNotice,
  type ProviderRow,
  accountName,
  formatDate,
  withoutConnectedParams,
} from "@/lib/connected-accounts";
import type { ConnectedAccount } from "@/lib/identity";
import { Brand, ObIcon } from "./onboarding/ob";
import "./connected-accounts.css";

/**
 * Settings → Connected accounts (#344): Google and GitHub, each with the accounts connected
 * through it (which email, since when) and a way to connect one or disconnect it after a confirm.
 * `notice` is the banner for a connection that just finished (`?linked=`) or failed (`?error=`).
 */
export function ConnectedAccounts({ rows, email, notice }: { rows: ProviderRow[]; email: string; notice: ConnectedNotice | null }) {
  return (
    <div className="ca">
      {notice ? <NoticeBanner notice={notice} /> : null}
      <ul className="ca-list" aria-label="Sign-in providers">
        {rows.map((row) => (
          <ProviderItem key={row.provider} row={row} />
        ))}
      </ul>
      <p className="ca-foot">
        <ObIcon name="mail" />
        <span>
          You can always sign in with a code sent to <b>{email}</b>, so disconnecting an account never locks you out.
        </span>
      </p>
    </div>
  );
}

function NoticeBanner({ notice }: { notice: ConnectedNotice }) {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  const dismiss = () => {
    setOpen(false);
    try {
      window.history.replaceState(window.history.state, "", withoutConnectedParams(window.location.href));
    } catch {
      // Some embedded browsers refuse replaceState; the banner is hidden either way.
    }
  };
  return (
    <div className={`ob-notice ca-notice ca-notice--${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"} data-code={notice.code}>
      <ObIcon name={notice.tone === "ok" ? "done" : "info"} />
      <p>{notice.text}</p>
      <button type="button" className="ob-notice-x" aria-label="Dismiss" onClick={dismiss}>
        <svg className="ob-ic" viewBox="0 0 16 16" aria-hidden="true">
          <path d="m4 4 8 8M12 4l-8 8" />
        </svg>
      </button>
    </div>
  );
}

function ProviderItem({ row }: { row: ProviderRow }) {
  const [accounts, setAccounts] = useState(row.accounts);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const connected = accounts.length > 0;

  const connect = () => {
    setError(null);
    start(async () => {
      // Sends the browser to the provider; answers only when the flow could not start.
      const result = await connectAccount(row.provider);
      if (result && !result.ok) setError(result.error);
    });
  };

  const headId = `ca-${row.provider}`;
  return (
    <li className="ca-item" aria-labelledby={headId}>
      <div className="ca-row">
        <span className="ca-logo" aria-hidden="true">
          <Brand src={row.provider} label="" />
        </span>
        <div className="ca-what">
          <h2 id={headId}>{row.label}</h2>
          <p>
            {connected
              ? `${accounts.length} account${accounts.length === 1 ? "" : "s"} connected`
              : row.available
                ? "Not connected"
                : "Not available on this server"}
          </p>
        </div>
        {!connected && row.available ? (
          <button
            type="button"
            className={`ah-btn ah-btn--secondary ah-btn--sm${pending ? " is-loading" : ""}`}
            onClick={connect}
            disabled={pending}
            aria-label={`Connect ${row.label}`}
          >
            Connect
          </button>
        ) : null}
      </div>
      {connected ? (
        <ul className="ca-accounts">
          {accounts.map((a) => (
            <AccountItem key={a.id} account={a} label={row.label} onGone={() => setAccounts((list) => list.filter((x) => x.id !== a.id))} />
          ))}
        </ul>
      ) : null}
      {error ? (
        <p className="ob-err ca-err" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}

function AccountItem({ account, label, onGone }: { account: ConnectedAccount; label: string; onGone: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  const name = accountName(account);
  const since = formatDate(account.created_at);
  const used = formatDate(account.last_login_at);
  const detail = [
    account.username && account.email ? account.email : null,
    since ? `Connected ${since}` : null,
    used ? `last sign-in ${used}` : null,
  ].filter(Boolean);

  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);

  const close = () => {
    setConfirming(false);
    setError(null);
    // Back to the button that opened the confirm, so keyboard users keep their place.
    requestAnimationFrame(() => openRef.current?.focus());
  };

  const disconnect = () => {
    start(async () => {
      const result = await disconnectAccount(account.id);
      if (result.ok) onGone();
      else setError(result.error);
    });
  };

  return (
    <li className="ca-acct">
      <div className="ca-acct__row">
        <div className="ca-acct__who">
          <b>{name}</b>
          {detail.length ? <span>{detail.join(" · ")}</span> : null}
        </div>
        {confirming ? null : (
          <button
            ref={openRef}
            type="button"
            className="ah-btn ah-btn--ghost ah-btn--sm ca-disconnect"
            onClick={() => setConfirming(true)}
            aria-label={`Disconnect ${label} account ${name}`}
          >
            Disconnect
          </button>
        )}
      </div>
      {confirming ? (
        <div
          className="ca-confirm"
          role="group"
          aria-label={`Disconnect ${name}`}
          onKeyDown={(e) => {
            if (e.key === "Escape" && !pending) close();
          }}
        >
          <p>
            Disconnect <b>{name}</b>? You won’t be able to sign in with this {label} account until you connect it again.
          </p>
          {error ? (
            <p className="ob-err" role="alert">
              {error}
            </p>
          ) : null}
          <div className="row">
            <button ref={cancelRef} type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={close} disabled={pending}>
              Cancel
            </button>
            <button type="button" className={`ah-btn ah-btn--sm ca-btn-danger${pending ? " is-loading" : ""}`} onClick={disconnect} disabled={pending}>
              Disconnect
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
