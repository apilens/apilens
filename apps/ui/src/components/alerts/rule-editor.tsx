"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useId, useState, useTransition } from "react";
import { createAlertRule, deleteAlertRule, updateAlertRule } from "@/app/[project]/incidents/actions";
import {
  CONDITIONS,
  METRICS,
  READ_ONLY,
  type RuleDraft,
  type RuleErrors,
  type RuleField,
  channelTypeLabel,
  channelsHref,
  checkRuleDraft,
  incidentHref,
  newRuleDraft,
  ruleDraftOf,
  rulesHref,
  thresholdUnit,
} from "@/lib/alerts";
import type { AlertRule, ConsumerGroup, NamedApp, NotificationChannel } from "@/lib/identity";
import { useCan } from "@/lib/permissions";
import { ObIcon } from "../onboarding/ob";
import "../org-settings/members.css";
import { AlertsHeader } from "./common";

type Status = { tone: "ok" | "err"; text: string } | null;

/**
 * `/<project>/incidents/rules/new` and `/<project>/incidents/rules/<id>` (#610): the alert rule
 * editor. What to watch (app, environment and the optional consumer, consumer group and endpoint
 * filters), the condition (metric, comparison, threshold, window), the timing (a fixed frequency
 * or a cron schedule, and how long a breach must hold before it notifies or clear before it
 * resolves) and the channels to notify. Project admins (`alerts.manage`) save and delete; everyone
 * else sees the same form read-only. `channels` and `groups` are null when they could not be
 * loaded (the form says so and keeps working without them).
 */
export function RuleEditor({
  project,
  projectName,
  rule,
  apps,
  environments,
  channels,
  groups,
}: {
  project: string;
  projectName: string;
  rule: AlertRule | null;
  apps: NamedApp[];
  environments: string[];
  channels: NotificationChannel[] | null;
  groups: ConsumerGroup[] | null;
}) {
  const manage = useCan("alerts.manage").allowed;
  const router = useRouter();
  const id = useId();
  const [draft, setDraft] = useState<RuleDraft>(() => (rule ? ruleDraftOf(rule) : newRuleDraft(apps.length === 1 ? apps[0].id : "", environments.includes("production") ? "production" : (environments[0] ?? ""))));
  const [errors, setErrors] = useState<RuleErrors>({});
  const [status, setStatus] = useState<Status>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, start] = useTransition();
  const editing = rule !== null;
  const locked = !manage || pending;

  const set = <K extends RuleField>(key: K, value: RuleDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
    setStatus(null);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (locked) return;
    const checked = checkRuleDraft(draft);
    if (!checked.ok) {
      setErrors(checked.errors);
      setStatus({ tone: "err", text: "Check the highlighted fields." });
      const first = Object.keys(checked.errors)[0];
      document.getElementById(`${id}-${first}`)?.focus();
      return;
    }
    start(async () => {
      const result = editing ? await updateAlertRule(project, rule.id, draft) : await createAlertRule(project, draft);
      if (!result.ok) {
        setErrors((result.errors as RuleErrors) ?? {});
        setStatus({ tone: "err", text: result.error });
        return;
      }
      if (editing) {
        setStatus({ tone: "ok", text: `Saved ${draft.name.trim()}.` });
        router.refresh();
      } else {
        router.push(rulesHref(project));
      }
    });
  };

  const remove = () => {
    if (!manage || pending || !rule) return;
    start(async () => {
      const result = await deleteAlertRule(project, rule.id);
      if (!result.ok) {
        setStatus({ tone: "err", text: result.error });
        return;
      }
      router.push(rulesHref(project));
    });
  };

  const field = (key: RuleField, label: string, input: ReactNode, hint?: string) => (
    <div className="ob-f">
      <label className="ob-l" htmlFor={`${id}-${key}`}>
        {label}
      </label>
      {input}
      {errors[key] ? (
        <p className="ob-err" id={`${id}-${key}-err`}>
          {errors[key]}
        </p>
      ) : hint ? (
        <p className="al-hint" id={`${id}-${key}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
  const described = (key: RuleField, hint?: boolean) => (errors[key] ? `${id}-${key}-err` : hint ? `${id}-${key}-hint` : undefined);
  const text = (key: RuleField, opts: { placeholder?: string; unit?: string; inputMode?: "numeric" | "decimal"; hint?: boolean; list?: string } = {}) => (
    <div className={`ob-in${errors[key] ? " bad" : ""}`}>
      <input
        id={`${id}-${key}`}
        value={draft[key] as string}
        placeholder={opts.placeholder}
        inputMode={opts.inputMode}
        list={opts.list}
        autoComplete="off"
        disabled={locked}
        aria-invalid={errors[key] ? true : undefined}
        aria-describedby={described(key, opts.hint)}
        onChange={(e) => set(key, e.target.value as never)}
      />
      {opts.unit ? <span className="al-unit">{opts.unit}</span> : null}
    </div>
  );
  const select = (key: RuleField, options: { value: string; label: string }[], disabled = locked) => (
    <select id={`${id}-${key}`} className="om-select" value={draft[key] as string} disabled={disabled} aria-invalid={errors[key] ? true : undefined} aria-describedby={described(key)} onChange={(e) => set(key, e.target.value as never)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );

  const toggleChannel = (cid: string) => set("channel_ids", draft.channel_ids.includes(cid) ? draft.channel_ids.filter((c) => c !== cid) : [...draft.channel_ids, cid]);
  const appOptions = [...(editing ? [] : [{ value: "", label: "Pick an app" }]), ...apps.map((a) => ({ value: a.id, label: a.name || a.slug }))];
  if (editing && !apps.some((a) => a.id === draft.app_id)) appOptions.unshift({ value: draft.app_id, label: "Unknown app" });

  return (
    <div className="al al--narrow">
      <AlertsHeader project={project} projectName={projectName} tab="rules" title={editing ? rule.name : "New alert rule"}>
        {editing ? (
          <Link className="ah-btn ah-btn--secondary ah-btn--sm" href={incidentHref(project, rule.id)}>
            View incidents
          </Link>
        ) : null}
      </AlertsHeader>

      {manage ? null : (
        <p className="os-note">
          <ObIcon name="lock" />
          <span>{READ_ONLY}</span>
        </p>
      )}

      <form className="al-form" onSubmit={submit} noValidate aria-label={editing ? `Edit ${rule.name}` : "New alert rule"}>
        <section className="os-card" aria-labelledby={`${id}-scope-h`}>
          <div className="os-card__head">
            <h2 id={`${id}-scope-h`}>What to watch</h2>
            <p>The requests of one app in one environment, optionally narrowed to a consumer, a consumer group or an endpoint.</p>
          </div>
          <div className="os-card__body">
            {field("name", "Name", text("name", { placeholder: "Checkout error rate" }))}
            <div className="ob-f">
              <label className="ob-l" htmlFor={`${id}-description`}>
                Description <small>Optional</small>
              </label>
              <textarea id={`${id}-description`} value={draft.description} disabled={locked} aria-invalid={errors.description ? true : undefined} onChange={(e) => set("description", e.target.value)} />
              {errors.description ? <p className="ob-err">{errors.description}</p> : null}
            </div>
            <div className="al-grid">
              {field("app_id", "App", select("app_id", appOptions, locked || editing), editing ? "A rule’s app never changes." : undefined)}
              {field("environment", "Environment", text("environment", { placeholder: "production", list: `${id}-envs` }))}
            </div>
            <datalist id={`${id}-envs`}>
              {environments.map((e) => (
                <option key={e} value={e} />
              ))}
            </datalist>
            <div className="al-grid al-grid--3">
              {field("endpoint", "Endpoint", text("endpoint", { placeholder: "GET /orders/{id}", hint: true }), "Optional. Leave out the method for every method.")}
              {field("consumer", "Consumer", text("consumer", { placeholder: "acme-corp", hint: true }), "Optional. The consumer id the SDK reports.")}
              {field(
                "group",
                "Consumer group",
                select("group", [{ value: "", label: groups === null ? "Couldn’t load groups" : "Any group" }, ...(groups ?? []).map((g) => ({ value: g.id, label: g.name }))], locked || (groups === null && draft.group === "")),
              )}
            </div>
          </div>
        </section>

        <section className="os-card" aria-labelledby={`${id}-cond-h`}>
          <div className="os-card__head">
            <h2 id={`${id}-cond-h`}>Condition</h2>
            <p>The rule breaches when the metric, aggregated over the window, crosses the threshold.</p>
          </div>
          <div className="os-card__body">
            <div className="al-grid">
              {field(
                "metric",
                "Metric",
                select(
                  "metric",
                  METRICS.map((m) => ({ value: m.value, label: m.label })),
                ),
              )}
              {field("condition", "When it", select("condition", CONDITIONS.map((c) => ({ value: c.value, label: c.label }))))}
              {field("threshold", "Threshold", text("threshold", { inputMode: "decimal", unit: thresholdUnit(draft.metric) }))}
              {field("window_min", "Over the last", text("window_min", { inputMode: "numeric", unit: "min" }))}
            </div>
          </div>
        </section>

        <section className="os-card" aria-labelledby={`${id}-time-h`}>
          <div className="os-card__head">
            <h2 id={`${id}-time-h`}>Timing</h2>
            <p>How often the rule is checked, and how long a breach must hold before anyone is notified or clear before the incident resolves.</p>
          </div>
          <div className="os-card__body">
            <fieldset>
              <legend className="al-sr">Check</legend>
              <div className="al-choice">
                <label className="al-check">
                  <input type="radio" name={`${id}-schedule`} checked={draft.schedule === "every"} disabled={locked} onChange={() => set("schedule", "every")} />
                  <span>At a fixed frequency</span>
                </label>
                <label className="al-check">
                  <input type="radio" name={`${id}-schedule`} checked={draft.schedule === "cron"} disabled={locked} onChange={() => set("schedule", "cron")} />
                  <span>On a cron schedule</span>
                </label>
              </div>
            </fieldset>
            <div className="al-grid al-grid--3">
              {draft.schedule === "every"
                ? field("every_min", "Check every", text("every_min", { inputMode: "numeric", unit: "min" }))
                : field("cron", "Cron schedule", text("cron", { placeholder: "*/5 * * * *", hint: true }), "Five fields, in UTC.")}
              {field("notify_after_min", "Notify after", text("notify_after_min", { inputMode: "numeric", unit: "min", hint: true }), "0 notifies at once.")}
              {field("resolve_after_min", "Resolve after", text("resolve_after_min", { inputMode: "numeric", unit: "min" }))}
            </div>
          </div>
        </section>

        <section className="os-card" aria-labelledby={`${id}-notify-h`}>
          <div className="os-card__head">
            <h2 id={`${id}-notify-h`}>Notify</h2>
            <p>
              Where notifications go. Channels are set up in{" "}
              <Link className="cp-link" href={channelsHref(project)}>
                Project settings, Alert channels
              </Link>
              .
            </p>
          </div>
          <div className="os-card__body">
            {channels === null ? (
              <p className="ob-err" role="alert">
                We couldn’t load the project’s channels. Reload the page to pick them.
              </p>
            ) : channels.length === 0 ? (
              <p className="al-hint">No alert channels yet. Without one, incidents still open here but nobody is notified.</p>
            ) : (
              <fieldset>
                <legend className="al-sr">Channels</legend>
                <div className="al-checks">
                  {channels.map((c) => (
                    <label key={c.id} className="al-check">
                      <input type="checkbox" checked={draft.channel_ids.includes(c.id)} disabled={locked} onChange={() => toggleChannel(c.id)} />
                      <span>
                        {c.name}
                        <small>{channelTypeLabel(c.type)}</small>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            {errors.channel_ids ? <p className="ob-err">{errors.channel_ids}</p> : null}
            <div className="al-choice">
              <label className="al-check">
                <input type="checkbox" checked={draft.enabled} disabled={locked} onChange={(e) => set("enabled", e.target.checked)} />
                <span>Enabled: check this rule on its schedule</span>
              </label>
            </div>
          </div>
        </section>

        {manage ? (
          <div className="al-foot">
            <p className={`os-status${status ? ` ${status.tone}` : ""}`} role="status" aria-live="polite">
              {status?.text ?? ""}
            </p>
            {editing ? (
              confirmDelete ? (
                <>
                  <span className="al-muted">Delete this rule and its incidents?</span>
                  <button type="button" className={`ah-btn ah-btn--sm os-btn-danger${pending ? " is-loading" : ""}`} onClick={remove} disabled={pending}>
                    Delete rule
                  </button>
                  <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={() => setConfirmDelete(false)} disabled={pending}>
                    Keep it
                  </button>
                </>
              ) : (
                <button type="button" className="ah-btn ah-btn--sm os-btn-outline-danger" onClick={() => setConfirmDelete(true)} disabled={pending}>
                  Delete
                </button>
              )
            ) : null}
            <Link className="ah-btn ah-btn--ghost ah-btn--sm" href={rulesHref(project)}>
              Cancel
            </Link>
            <button type="submit" className={`ah-btn ah-btn--primary ah-btn--sm${pending ? " is-loading" : ""}`} disabled={pending}>
              {editing ? "Save rule" : "Create rule"}
            </button>
          </div>
        ) : null}
      </form>
    </div>
  );
}
