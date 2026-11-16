"use client";

import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { type ExploreState, exploreHref } from "@/lib/explore";
import {
  type ExploreFilters,
  FILTER_DEBOUNCE_MS,
  type FilterChip,
  type FilterDraft,
  type FilterKey,
  type FilterSuggestions,
  METHODS,
  NO_FILTERS,
  NO_SUGGESTIONS,
  consumerSuggestions,
  endpointSuggestions,
  filterChips,
  fromDraft,
  sameFilters,
  toDraft,
  withoutChip,
} from "@/lib/explore-filters";
import { Combobox } from "./combobox";
import { SaveView } from "./saved-views";

/** How many of its own recent changes the bar recognises when the page comes back with them. */
const SENT_KEPT = 8;

/**
 * The Explore filter bar (#586): every filter of the request log, kept in the URL so a link
 * reproduces the view. Active filters show as chips (each removable) with Clear all; the Filters
 * button opens the form. Pickers apply at once; typed fields apply once typing pauses
 * (FILTER_DEBOUNCE_MS) and only when valid, so the log never reads a filter the API would refuse.
 * `navigate(href, replace)` moves the page; typing replaces the history entry. Path and Consumer
 * suggest the project's endpoints and consumers (#983); picking one applies at once.
 */
export function FilterBar({
  project,
  environments,
  suggestions = NO_SUGGESTIONS,
  query: q,
  navigate,
}: {
  project: string;
  environments: readonly string[];
  suggestions?: FilterSuggestions;
  query: ExploreState;
  navigate: (href: string, replace: boolean) => void;
}) {
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<FilterDraft>(() => toDraft(q.filters));
  // The filters this bar sent to the URL lately, newest last: when the page comes back with one of
  // them it is our own change, and the form keeps what the user typed since.
  const sent = useRef<ExploreFilters[]>([q.filters]);
  const latest = useRef(q);
  latest.current = q;

  // The page came back with one of our changes: forget the older ones, keep the draft. Anything
  // else changed the URL elsewhere (back/forward, the empty state's Clear all): show it.
  useEffect(() => {
    const echo = sent.current.findIndex((f) => sameFilters(f, q.filters));
    if (echo >= 0) {
      sent.current = sent.current.slice(echo);
      return;
    }
    sent.current = [q.filters];
    setDraft(toDraft(q.filters));
  }, [q.filters]);

  const apply = (filters: ExploreFilters, replace: boolean) => {
    sent.current = [...sent.current.slice(-(SENT_KEPT - 1)), filters];
    navigate(exploreHref(project, { ...latest.current, filters }), replace);
  };

  // Typed fields: apply the draft once typing pauses, if it is valid and says something new.
  useEffect(() => {
    const r = fromDraft(draft);
    if (!r.ok || sameFilters(r.filters, sent.current[sent.current.length - 1])) return;
    const t = window.setTimeout(() => apply(r.filters, true), FILTER_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
    // apply reads the latest query through a ref; only the draft starts a new wait.
  }, [draft]);

  const check = fromDraft(draft);
  const errors = check.ok ? {} : check.errors;
  const chips = filterChips(q.filters, suggestions.consumers);

  const type = (k: FilterKey, v: string) => setDraft((d) => ({ ...d, [k]: v }));
  const pick = (k: FilterKey, v: string) => pickAll({ [k]: v });
  const pickAll = (values: Partial<FilterDraft>) => {
    const next = { ...draft, ...values };
    setDraft(next);
    const r = fromDraft(next);
    if (r.ok) apply(r.filters, false);
  };
  const remove = (chip: FilterChip) => {
    const next = withoutChip(q.filters, chip);
    setDraft(toDraft(next));
    apply(next, false);
  };
  const clearAll = () => {
    setDraft(toDraft(NO_FILTERS));
    apply(NO_FILTERS, false);
  };

  const text = (k: FilterKey, label: string, opts: { placeholder?: string; hint?: string; mono?: boolean } = {}) => (
    <Field id={`${formId}-${k}`} label={label} hint={opts.hint} error={errors[k]}>
      {(props) => (
        <input
          {...props}
          type="text"
          className={`ex-input${opts.mono ? " ex-input--mono" : ""}`}
          value={draft[k]}
          placeholder={opts.placeholder}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => type(k, e.target.value)}
        />
      )}
    </Field>
  );

  const bound = (k: FilterKey, label: string) => (
    <input
      id={`${formId}-${k}`}
      type="text"
      inputMode="decimal"
      className="ex-input ex-input--num"
      aria-label={label}
      aria-invalid={errors[k] ? true : undefined}
      aria-describedby={errors[k] ? `${formId}-${k}-error` : undefined}
      value={draft[k]}
      placeholder={label.endsWith("minimum") ? "Min" : "Max"}
      autoComplete="off"
      onChange={(e) => type(k, e.target.value)}
    />
  );

  const range = (lo: FilterKey, hi: FilterKey, legend: string) => {
    const err = errors[lo] ?? errors[hi];
    const errKey = errors[lo] ? lo : hi;
    return (
      <fieldset className="ex-field ex-range">
        <legend className="ex-label">{legend}</legend>
        <div className="ex-range__inputs">
          {bound(lo, `${legend} minimum`)}
          <span aria-hidden="true">to</span>
          {bound(hi, `${legend} maximum`)}
        </div>
        {err ? (
          <p className="ex-error" id={`${formId}-${errKey}-error`}>
            {err}
          </p>
        ) : null}
      </fieldset>
    );
  };

  // A shared link may name an environment or method the pickers do not list; keep it selectable.
  const envOptions = draft.env && !environments.includes(draft.env) ? [...environments, draft.env] : environments;
  const methodOptions: readonly string[] = draft.method && !(METHODS as readonly string[]).includes(draft.method) ? [...METHODS, draft.method] : METHODS;

  return (
    <section className="ex-filters" aria-label="Filters">
      <div className="ex-filters__bar">
        <button type="button" className="ah-btn ah-btn--secondary ah-btn--sm" aria-expanded={open} aria-controls={formId} onClick={() => setOpen((o) => !o)}>
          Filters{chips.length ? ` (${chips.length})` : ""}
        </button>
        {chips.length ? (
          <ul className="ex-chips" aria-label="Active filters">
            {chips.map((c) => (
              <li key={c.id} className="ex-chip">
                <span title={c.label}>{c.label}</span>
                <button type="button" className="ex-chip__x" aria-label={`Remove filter: ${c.label}`} onClick={() => remove(c)}>
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <path d="M4 4l8 8M12 4l-8 8" />
                  </svg>
                </button>
              </li>
            ))}
            <li>
              <button type="button" className="ah-btn ah-btn--ghost ah-btn--sm" onClick={clearAll}>
                Clear all
              </button>
            </li>
          </ul>
        ) : null}
        {/* Saved views (#589): name the filters on now. */}
        <SaveView />
      </div>

      <div id={formId} className="ex-form" hidden={!open}>
        <Field id={`${formId}-env`} label="Environment">
          {(props) => (
            <select {...props} className="ex-input" value={draft.env} onChange={(e) => pick("env", e.target.value)}>
              <option value="">All environments</option>
              {envOptions.map((env) => (
                <option key={env} value={env}>
                  {env}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field id={`${formId}-method`} label="Method">
          {(props) => (
            <select {...props} className="ex-input" value={draft.method} onChange={(e) => pick("method", e.target.value)}>
              <option value="">Any method</option>
              {methodOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          )}
        </Field>
        {text("status", "Status", { placeholder: "4xx, 500-503", hint: "Codes, classes or ranges, comma-separated.", mono: true })}
        <Field id={`${formId}-path`} label="Path" hint="A route template, or part of a URL from the log." error={errors.path}>
          {(props) => (
            <Combobox
              {...props}
              label="Path suggestions"
              mono
              placeholder="/orders/{id}"
              value={draft.path}
              options={endpointSuggestions(suggestions.endpoints, draft.path, draft.method).map((e) => ({ key: `${e.method} ${e.path}`, lead: e.method, text: e.path }))}
              onType={(v) => type("path", v)}
              onPick={(o) => pickAll({ method: o.lead ?? "", path: o.text })}
            />
          )}
        </Field>
        {text("url_contains", "URL contains", { placeholder: "?expand=", mono: true })}
        {text("payload_contains", "Payload contains", { hint: "Searches request and response bodies, kept only for sampled requests with body capture on." })}
        <Field id={`${formId}-consumer_id`} label="Consumer" hint="A name or an ID." error={errors.consumer_id}>
          {(props) => (
            <Combobox
              {...props}
              label="Consumer suggestions"
              value={draft.consumer_id}
              options={consumerSuggestions(suggestions.consumers, draft.consumer_id).map((c) => ({
                key: c.id,
                text: c.name.trim() || c.id,
                detail: c.name.trim() && c.name.trim() !== c.id ? c.id : undefined,
              }))}
              onType={(v) => type("consumer_id", v)}
              onPick={(o) => pick("consumer_id", o.key)}
            />
          )}
        </Field>
        {text("consumer_group", "Consumer group")}
        {text("ip", "Client IP", { placeholder: "203.0.113.7", mono: true })}
        {range("request_size_min", "request_size_max", "Request size (bytes)")}
        {range("response_size_min", "response_size_max", "Response size (bytes)")}
        {range("latency_min", "latency_max", "Latency (ms)")}
        <Field id={`${formId}-sampled`} label="Sampling">
          {(props) => (
            <select {...props} className="ex-input" value={draft.sampled} onChange={(e) => pick("sampled", e.target.value)}>
              <option value="">Kept in full and sampled out</option>
              <option value="true">Kept in full</option>
              <option value="false">Sampled out</option>
            </select>
          )}
        </Field>
      </div>
    </section>
  );
}

type ControlProps = { id: string; "aria-invalid"?: boolean; "aria-describedby"?: string };

/** One labelled form field with an optional hint and error, wired for screen readers. */
function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string; children: (props: ControlProps) => ReactNode }) {
  const described = [hint ? `${id}-hint` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ");
  return (
    <div className="ex-field">
      <label className="ex-label" htmlFor={id}>
        {label}
      </label>
      {children({ id, "aria-invalid": error ? true : undefined, "aria-describedby": described || undefined })}
      {error ? (
        <p className="ex-error" id={`${id}-error`}>
          {error}
        </p>
      ) : hint ? (
        <p className="ex-hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
