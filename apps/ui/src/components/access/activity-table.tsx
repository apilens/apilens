"use client";

import { useEffect, useId, useRef, useState } from "react";
import { auditSentence, changedFields, fieldValue, relativeTime } from "@/lib/audit";
import type { AuditEvent } from "@/lib/identity";
import { formatExact } from "@/lib/passkey-settings";
import { CopyValue } from "../copy-value";

/** Where an event happened on the organization's log: its project, or the organization itself. */
function ProjectCell({ e }: { e: AuditEvent }) {
  return e.project ? <span>{e.project.name || e.project.slug}</span> : <span className="pk-muted">Organization</span>;
}

/**
 * The Activity table (#812): when (relative, exact on hover), who, what in a sentence, the target
 * and the IP; on the organization's audit log (`scope` org, #813) also the project. Each row's
 * sentence is a button: it (or a click anywhere on the row) opens the detail panel. `labels` names
 * each action (`auditActions`); `now` is the load time.
 */
export function ActivityTable({
  events,
  labels,
  now,
  scope = "project",
}: {
  events: AuditEvent[];
  labels: Record<string, string>;
  now: number;
  scope?: "project" | "org";
}) {
  const org = scope === "org";
  const [open, setOpen] = useState<AuditEvent | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);

  const show = (e: AuditEvent, button: HTMLButtonElement | null) => {
    opener.current = button;
    setOpen(e);
  };

  return (
    <>
      <table className="pk-table acl-table">
        <caption className="pk-sr">{org ? "Activity in this organization" : "Activity on this project"}, newest first. Select an event to see its details.</caption>
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Who</th>
            <th scope="col">What</th>
            {org ? <th scope="col">Project</th> : null}
            <th scope="col">Target</th>
            <th scope="col">IP</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr
              key={e.id}
              className="pk-row acl-row"
              onClick={(ev) => {
                const button = (ev.currentTarget as HTMLTableRowElement).querySelector<HTMLButtonElement>("button.acl-open");
                show(e, button);
              }}
            >
              <td data-label="Time">
                <time dateTime={e.time} title={formatExact(e.time)}>
                  {relativeTime(e.time, now)}
                </time>
              </td>
              <td data-label="Who" className={e.actor.type === "system" ? "pk-muted" : undefined}>
                {e.actor.label || (e.actor.type === "system" ? "System" : "Unknown")}
              </td>
              <td data-label="What" className="acl-what">
                <button
                  type="button"
                  className="acl-open"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    show(e, ev.currentTarget);
                  }}
                >
                  {auditSentence(e)}
                </button>
              </td>
              {org ? (
                <td data-label="Project" className="acl-project">
                  <ProjectCell e={e} />
                </td>
              ) : null}
              <td data-label="Target" className="acl-target">
                {e.target ? (
                  <>
                    <span>{e.target.label || e.target.id}</span> <span className="pk-muted">{e.target.type.replace(/_/g, " ")}</span>
                  </>
                ) : (
                  <span className="pk-muted">–</span>
                )}
              </td>
              <td data-label="IP" className="acl-mono">
                {e.ip || <span className="pk-muted">–</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {open ? (
        <ActivityDetail
          event={open}
          label={labels[open.action]}
          now={now}
          org={org}
          onClose={() => {
            setOpen(null);
            opener.current?.focus();
          }}
        />
      ) : null}
    </>
  );
}

/**
 * One event in full, as a modal side panel: every field, the request id with copy, and the changed
 * fields before and after. Escape, the close button and a click outside close it; focus then goes
 * back to the row it was opened from.
 */
function ActivityDetail({ event: e, label, now, org, onClose }: { event: AuditEvent; label: string | undefined; now: number; org: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  const changes = changedFields(e.changes);
  return (
    <dialog
      ref={ref}
      className="acl-panel"
      aria-labelledby={titleId}
      onClose={onClose}
      onMouseDown={(ev) => {
        if (ev.target === ev.currentTarget) ref.current?.close();
      }}
    >
      <div className="acl-panel__in">
        <header className="acl-panel__head">
          <div>
            <h2 id={titleId} className="acl-panel__title">
              {auditSentence(e)}
            </h2>
            <p className="acl-panel__sub">
              <time dateTime={e.time}>{formatExact(e.time)}</time> · {relativeTime(e.time, now)}
            </p>
          </div>
          <button type="button" className="acl-close" aria-label="Close event details" onClick={() => ref.current?.close()}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </header>

        <div className="acl-panel__body">
          <dl className="acl-fields">
            <div>
              <dt>Action</dt>
              <dd>
                {label ? `${label} ` : null}
                <code className="acl-mono">{e.action}</code>
              </dd>
            </div>
            <div>
              <dt>Who</dt>
              <dd>
                {e.actor.label || (e.actor.type === "system" ? "System" : "Unknown")}
                {e.actor.id ? <span className="acl-mono pk-muted acl-id">{e.actor.id}</span> : null}
              </dd>
            </div>
            {org ? (
              <div>
                <dt>Project</dt>
                <dd>
                  <ProjectCell e={e} />
                </dd>
              </div>
            ) : null}
            <div>
              <dt>Target</dt>
              <dd>
                {e.target ? (
                  <>
                    {e.target.label || "–"} <span className="pk-muted">{e.target.type.replace(/_/g, " ")}</span>
                    <span className="acl-mono pk-muted acl-id">{e.target.id}</span>
                  </>
                ) : (
                  "–"
                )}
              </dd>
            </div>
            <div>
              <dt>IP address</dt>
              <dd className="acl-mono">{e.ip || "–"}</dd>
            </div>
            <div>
              <dt>User agent</dt>
              <dd className="acl-ua">{e.user_agent || "–"}</dd>
            </div>
            <div>
              <dt>Request id</dt>
              <dd>{e.request_id ? <CopyValue value={e.request_id} label="request id" /> : <span className="pk-muted">None: this happened outside a request</span>}</dd>
            </div>
            <div>
              <dt>Event id</dt>
              <dd className="acl-mono">{e.id}</dd>
            </div>
          </dl>

          <h3 className="acl-panel__h">Changes</h3>
          {changes.length === 0 ? (
            <p className="pk-muted acl-none">This event records no changed fields.</p>
          ) : (
            <table className="acl-changes">
              <caption className="pk-sr">Changed fields, before and after</caption>
              <thead>
                <tr>
                  <th scope="col">Field</th>
                  <th scope="col">Before</th>
                  <th scope="col">After</th>
                </tr>
              </thead>
              <tbody>
                {changes.map((c) => (
                  <tr key={c.field}>
                    <th scope="row" className="acl-mono">
                      {c.field}
                    </th>
                    <td className="acl-mono acl-before">{fieldValue(c.before)}</td>
                    <td className="acl-mono acl-after">{fieldValue(c.after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </dialog>
  );
}
