"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { restoreDeletedProject } from "@/app/orgs/[org]/settings/restore-actions";
import { HOME_VIEW } from "@/lib/data";
import { agoText, inText } from "@/lib/deleted-projects";
import type { DeletedProject } from "@/lib/identity";
import { formatExact } from "@/lib/passkey-settings";
import { REAUTH_CANCELLED } from "@/lib/reauth";
import { useReauth } from "../reauth-dialog";
import "./deleted-projects.css";

/** A relative date with the exact one beside it (and as its tooltip). */
function When({ iso, relative }: { iso: string; relative: string }) {
  const exact = formatExact(iso);
  return (
    <>
      <time dateTime={iso} title={exact} suppressHydrationWarning>
        {relative}
      </time>{" "}
      <span className="dp-exact">({exact})</span>
    </>
  );
}

/**
 * `/orgs/<org>/settings` → Deleted projects (#822): the organization's deleted projects that can
 * still be restored, with when each was deleted and when it is removed for good (#753 D8).
 * Owners and admins only (the page passes nothing for others); hidden when there are none.
 * Restoring needs a recent sign-in (D12) and ends with a link to the project.
 */
export function DeletedProjectsCard({
  org,
  initial,
  onRestored,
}: {
  org: string;
  /** Null when the list could not be loaded. */
  initial: DeletedProject[] | null;
  onRestored?: (slug: string) => void;
}) {
  const [rows, setRows] = useState(initial ?? []);
  const [restored, setRestored] = useState<{ slug: string; name: string } | null>(null);
  const [failure, setFailure] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const { withReauth, dialog } = useReauth();

  if (initial !== null && rows.length === 0 && restored === null) return null;

  const restore = (p: DeletedProject) => {
    if (pending) return;
    setFailure(null);
    setRestored(null);
    setBusy(p.id);
    start(async () => {
      const result = await withReauth(() => restoreDeletedProject(org, p.id));
      setBusy(null);
      if (result.ok) {
        setRows((list) => list.filter((r) => r.id !== p.id));
        setRestored(result.project);
        onRestored?.(p.slug);
      } else if (result.code !== REAUTH_CANCELLED) setFailure({ id: p.id, text: result.error });
    });
  };

  const now = Date.now();
  return (
    <section className="os-card dp" aria-labelledby="dp-title">
      <div className="os-card__head">
        <h2 id="dp-title">Deleted projects</h2>
        <p>Deleted projects can be restored with their members, API keys, apps and settings until their data is removed for good.</p>
      </div>
      <div className="os-card__body">
        {initial === null ? (
          <p className="dp-load-err" role="alert">
            Couldn’t load the deleted projects. Reload the page to try again.
          </p>
        ) : rows.length === 0 ? (
          <p className="dp-empty">No other deleted projects.</p>
        ) : (
          <ul className="dp-list">
            {rows.map((p) => (
              <li key={p.id} className="dp-row">
                <div className="dp-main">
                  <p className="dp-name">
                    <b>{p.name}</b> <span className="dp-slug">/{p.slug}</span>
                  </p>
                  <p className="dp-meta">
                    Deleted <When iso={p.deleted_at} relative={agoText(p.deleted_at, now)} />
                  </p>
                  <p className="dp-meta">
                    Removed for good <When iso={p.purge_after} relative={inText(p.purge_after, now)} />
                  </p>
                  {failure?.id === p.id ? (
                    <p id={`dp-err-${p.id}`} className="dp-err">
                      {failure.text}
                    </p>
                  ) : null}
                </div>
                <button
                  type="button"
                  className={`ah-btn ah-btn--sm ah-btn--ghost dp-restore${busy === p.id ? " is-loading" : ""}`}
                  onClick={() => restore(p)}
                  disabled={pending}
                  aria-label={`Restore ${p.name}`}
                  aria-describedby={failure?.id === p.id ? `dp-err-${p.id}` : undefined}
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="os-card__foot dp-foot">
        <span className="os-status ok" role="status" aria-live="polite">
          {restored ? (
            <>
              {restored.name} is restored.{" "}
              <Link href={`/${restored.slug}/${HOME_VIEW}`} className="dp-link">
                Open {restored.name}
              </Link>
            </>
          ) : (
            ""
          )}
        </span>
      </div>
      {/* Inside the card so .os-card + .os-card spacing holds; a modal dialog is rendered on top. */}
      {dialog}
    </section>
  );
}
