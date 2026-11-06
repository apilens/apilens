"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useId, useState, useTransition } from "react";
import { createChannel, deleteChannel, testChannel, updateChannel } from "@/app/[project]/incidents/actions";
import {
  CHANNELS_LOAD_FAILED,
  CHANNEL_TYPES,
  type ChannelDraft,
  type ChannelErrors,
  MAX_EMAIL_ADDRESSES,
  MIN_WEBHOOK_SECRET,
  READ_ONLY,
  channelTypeLabel,
  channelsHref,
  checkChannelDraft,
  newChannelDraft,
  rulesHref,
} from "@/lib/alerts";
import type { ChannelType, NotificationChannel } from "@/lib/identity";
import { useCan } from "@/lib/permissions";
import { ObIcon } from "../onboarding/ob";
import "../org-settings/members.css";
import "../org-settings/org-settings.css";
import "./alerts.css";

type Note = { tone: "ok" | "err"; text: string } | null;

/**
 * `/<project>/settings/alerts` (#610): where the project's alert notifications go. Each channel
 * (email, Slack, Microsoft Teams or a signed webhook) with Send test, Edit and Delete; a form adds
 * one. A channel's config (addresses, webhook URLs, the signing secret) is write-only: the API
 * never returns it, so editing shows blank fields that keep the saved config unless filled in.
 * Project admins (`alerts.manage`) change channels and send tests; everyone else sees the list.
 * `channels` is null when the API could not answer.
 */
export function ChannelsSettings({ project, projectName, channels }: { project: string; projectName: string; channels: NotificationChannel[] | null }) {
  const manage = useCan("alerts.manage").allowed;
  return (
    <div className="page page--measure os al-form">
      <header className="os-head">
        <p className="cp-h">{projectName} · Settings</p>
        <h1 className="cp-lede">Alert channels</h1>
        <p className="al-lead">
          Where the{" "}
          <a className="cp-link" href={rulesHref(project)}>
            alert rules
          </a>{" "}
          send notifications when an incident opens and when it resolves.
        </p>
      </header>

      {manage ? null : (
        <p className="os-note">
          <ObIcon name="lock" />
          <span>{READ_ONLY}</span>
        </p>
      )}

      {channels === null ? (
        <div className="al-notice al-notice--error" role="alert">
          <ObIcon name="info" />
          <p>
            {CHANNELS_LOAD_FAILED}{" "}
            <a className="cp-link" href={channelsHref(project)}>
              Try again
            </a>
          </p>
        </div>
      ) : (
        <>
          <section className="os-card" aria-labelledby="al-channels-h">
            <div className="os-card__head">
              <h2 id="al-channels-h">Channels</h2>
              <p>{channels.length === 0 ? "No channels yet." : `${channels.length} ${channels.length === 1 ? "channel" : "channels"}, by name.`}</p>
            </div>
            {channels.length > 0 ? (
              <ul className="al-channels" aria-label="Alert channels">
                {channels.map((c) => (
                  <ChannelRow key={c.id} project={project} channel={c} manage={manage} />
                ))}
              </ul>
            ) : (
              <div className="os-card__body">
                <p className="al-hint">{manage ? "Add one below, then pick it on each alert rule that should notify it." : "A project admin can add one."}</p>
              </div>
            )}
          </section>
          {manage ? <CreateChannel project={project} /> : null}
        </>
      )}
    </div>
  );
}

function ChannelRow({ project, channel: c, manage }: { project: string; channel: NotificationChannel; manage: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<"view" | "edit" | "delete">("view");
  const [note, setNote] = useState<Note>(null);
  const [pending, start] = useTransition();

  const test = () => {
    if (pending) return;
    setNote(null);
    start(async () => {
      const result = await testChannel(project, c.id);
      setNote(result.ok ? { tone: "ok", text: c.type === "email" ? "Test notification queued for sending." : "Test notification sent." } : { tone: "err", text: result.error });
    });
  };

  const remove = () => {
    if (pending) return;
    start(async () => {
      const result = await deleteChannel(project, c.id);
      if (!result.ok) return setNote({ tone: "err", text: result.error });
      router.refresh();
    });
  };

  return (
    <li className="al-channel">
      <div className="al-channel__who">
        <span className="al-name">{c.name}</span>
        <span className="al-meta">{channelTypeLabel(c.type)}</span>
      </div>
      {manage && mode === "view" ? (
        <div className="al-channel__actions">
          <button type="button" className={`ah-btn ah-btn--secondary ah-btn--sm${pending ? " is-loading" : ""}`} onClick={test} disabled={pending} aria-label={`Send a test notification to ${c.name}`}>
            Send test
          </button>
          <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={() => (setMode("edit"), setNote(null))} aria-label={`Edit ${c.name}`}>
            Edit
          </button>
          <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={() => (setMode("delete"), setNote(null))} aria-label={`Delete ${c.name}`}>
            Delete
          </button>
        </div>
      ) : null}
      {mode === "delete" ? (
        <div className="al-channel__actions">
          <span className="al-muted">Delete {c.name}? Rules stop notifying it.</span>
          <button type="button" className={`ah-btn ah-btn--sm os-btn-danger${pending ? " is-loading" : ""}`} onClick={remove} disabled={pending}>
            Delete channel
          </button>
          <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={() => setMode("view")} disabled={pending}>
            Cancel
          </button>
        </div>
      ) : null}
      {mode === "edit" ? (
        <div className="al-edit">
          <ChannelForm
            project={project}
            channel={c}
            onDone={(text) => {
              setMode("view");
              if (text) setNote({ tone: "ok", text });
            }}
          />
        </div>
      ) : null}
      <p className={`al-channel__note${note ? ` ${note.tone}` : ""}`} role="status" aria-live="polite">
        {note?.text ?? ""}
      </p>
    </li>
  );
}

function CreateChannel({ project }: { project: string }) {
  return (
    <section className="os-card" aria-labelledby="al-new-channel-h">
      <div className="os-card__head">
        <h2 id="al-new-channel-h">Add a channel</h2>
        <p>Configs are stored encrypted and never shown again.</p>
      </div>
      <div className="os-card__body">
        <ChannelForm project={project} channel={null} />
      </div>
    </section>
  );
}

/** The create form (`channel` null) or a channel's edit form; `onDone` closes an edit. */
function ChannelForm({ project, channel, onDone }: { project: string; channel: NotificationChannel | null; onDone?: (text?: string) => void }) {
  const router = useRouter();
  const id = useId();
  const editing = channel !== null;
  const [draft, setDraft] = useState<ChannelDraft>(() => ({ ...newChannelDraft(channel?.type ?? "email"), name: channel?.name ?? "" }));
  const [errors, setErrors] = useState<ChannelErrors>({});
  const [note, setNote] = useState<Note>(null);
  const [pending, start] = useTransition();

  const set = (key: keyof ChannelDraft, value: string) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
    setNote(null);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    const checked = checkChannelDraft(draft, editing);
    if (!checked.ok) {
      setErrors(checked.errors);
      document.getElementById(`${id}-${Object.keys(checked.errors)[0]}`)?.focus();
      return;
    }
    start(async () => {
      const result = editing ? await updateChannel(project, channel.id, draft) : await createChannel(project, draft);
      if (!result.ok) {
        setErrors((result.errors as ChannelErrors) ?? {});
        setNote({ tone: "err", text: result.error });
        return;
      }
      const text = editing ? `Saved ${checked.name}.` : `Added ${checked.name}.`;
      if (editing) onDone?.(text);
      else {
        setDraft(newChannelDraft(draft.type));
        setNote({ tone: "ok", text });
      }
      router.refresh();
    });
  };

  const keep = editing ? " Leave blank to keep the saved one." : "";
  const input = (key: keyof ChannelDraft, label: string, opts: { placeholder?: string; type?: string; hint?: string } = {}) => (
    <div className="ob-f">
      <label className="ob-l" htmlFor={`${id}-${key}`}>
        {label}
      </label>
      <div className={`ob-in${errors[key] ? " bad" : ""}`}>
        <input
          id={`${id}-${key}`}
          type={opts.type ?? "text"}
          value={draft[key]}
          placeholder={opts.placeholder}
          autoComplete="off"
          spellCheck={false}
          disabled={pending}
          aria-invalid={errors[key] ? true : undefined}
          aria-describedby={`${id}-${key}-note`}
          onChange={(e) => set(key, e.target.value)}
        />
      </div>
      <p id={`${id}-${key}-note`} className={errors[key] ? "ob-err" : "al-hint"}>
        {errors[key] ?? opts.hint ?? ""}
      </p>
    </div>
  );

  return (
    <form onSubmit={submit} noValidate aria-label={editing ? `Edit ${channel.name}` : "Add a channel"}>
      <div className="al-grid">
        <div className="ob-f">
          <label className="ob-l" htmlFor={`${id}-type`}>
            Type
          </label>
          <select id={`${id}-type`} className="om-select" value={draft.type} disabled={pending || editing} onChange={(e) => set("type", e.target.value as ChannelType)}>
            {CHANNEL_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          {editing ? <p className="al-hint">A channel’s type never changes.</p> : null}
        </div>
        {input("name", "Name", { placeholder: draft.type === "email" ? "On-call" : "#api-alerts" })}
      </div>
      {draft.type === "email" ? input("addresses", "Email addresses", { placeholder: "oncall@example.com, lead@example.com", hint: `Up to ${MAX_EMAIL_ADDRESSES}, separated by commas.${keep}` }) : null}
      {draft.type === "slack" || draft.type === "teams"
        ? input("webhook_url", "Incoming webhook URL", { type: "url", placeholder: "https://", hint: `The ${draft.type === "slack" ? "Slack" : "Teams"} incoming webhook to post to.${keep}` })
        : null}
      {draft.type === "webhook" ? (
        <div className="al-grid">
          {input("url", "URL", { type: "url", placeholder: "https://", hint: `Receives a signed JSON POST.${keep}` })}
          {input("secret", "Signing secret", { type: "password", hint: `At least ${MIN_WEBHOOK_SECRET} characters; signs every request.${keep}` })}
        </div>
      ) : null}
      <div className="al-foot">
        <p className={`os-status${note ? ` ${note.tone}` : ""}`} role="status" aria-live="polite">
          {note?.text ?? ""}
        </p>
        {editing ? (
          <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={() => onDone?.()} disabled={pending}>
            Cancel
          </button>
        ) : null}
        <button type="submit" className={`ah-btn ah-btn--primary ah-btn--sm${pending ? " is-loading" : ""}`} disabled={pending}>
          {editing ? "Save channel" : "Add channel"}
        </button>
      </div>
    </form>
  );
}
