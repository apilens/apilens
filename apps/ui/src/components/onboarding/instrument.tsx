"use client";

import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";
import type { OnboardingAnswers } from "@/lib/identity";
import {
  LANGUAGES,
  METHODS,
  type Method,
  RUNTIMES,
  effectiveMethod,
  languageEnabled,
  languageOf,
  methodsFor,
  recommend,
  recommendReason,
  savedInstrument,
} from "@/lib/instrument";
import { radioKeyTarget, radioTabStop } from "@/lib/radio-group";
import { BackNext, Brand, ObIcon, type ObIconName, ObShell, type StepProps } from "./ob";
import { useOnboardingContinue } from "./progress";
import "./instrument.css";

interface RadioItem {
  id: string;
  disabled?: boolean;
}

/**
 * A keyboard-navigable radio group (WAI-ARIA APG): one Tab stop, arrow keys move and check,
 * Home/End jump, disabled radios are skipped. `render` draws one radio with the props it needs.
 */
function RadioGroup<T extends RadioItem>({
  label,
  labelledBy,
  className,
  items,
  value,
  onChange,
  render,
}: {
  label?: string;
  labelledBy?: string;
  className: string;
  items: readonly T[];
  value: string | undefined;
  onChange: (id: string) => void;
  render: (item: T, props: RadioProps) => ReactNode;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const disabled = items.map((i) => Boolean(i.disabled));
  const checked = items.findIndex((i) => i.id === value);
  const tabStop = radioTabStop(checked, disabled);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const from = refs.current.findIndex((el) => el === e.target);
    if (from < 0) return;
    const to = radioKeyTarget(e.key, from, disabled);
    if (to === null) return;
    e.preventDefault();
    onChange(items[to].id);
    refs.current[to]?.focus();
  };
  return (
    <div className={className} role="radiogroup" aria-label={label} aria-labelledby={labelledBy} onKeyDown={onKeyDown}>
      {items.map((item, i) =>
        render(item, {
          key: item.id,
          ref: (el: HTMLButtonElement | null) => {
            refs.current[i] = el;
          },
          type: "button",
          role: "radio",
          "aria-checked": i === checked,
          tabIndex: i === tabStop ? 0 : -1,
          disabled: item.disabled,
          onClick: () => onChange(item.id),
        }),
      )}
    </div>
  );
}

interface RadioProps {
  key: string;
  ref: (el: HTMLButtonElement | null) => void;
  type: "button";
  role: "radio";
  "aria-checked": boolean;
  tabIndex: number;
  disabled?: boolean;
  onClick: () => void;
}

const METHOD_COPY: Record<Method, { title: string; icon: ObIconName }> = {
  sdk: { title: "APILens SDK", icon: "code" },
  otlp: { title: "OpenTelemetry (OTLP)", icon: "link" },
  "url-check": { title: "Check a URL", icon: "eye" },
};

function methodDetail(method: Method, language: string | undefined): string {
  const lang = languageOf(language);
  if (method === "sdk") return lang?.sdk ? `Install ${lang.sdk} and add its middleware.` : "No APILens SDK for this language yet.";
  if (method === "otlp") return "Export traces and logs from OpenTelemetry to APILens.";
  return "Uptime and latency of a public endpoint, from outside.";
}

/** "A, B and C". */
function listOf(items: string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * "How do you want to instrument?" (#332), step 3: the language (only those with an APILens SDK
 * or an OpenTelemetry path can be picked), where it runs, and the method, which starts on the one
 * `recommend` picks for the two. Continue saves `language`, `runtime` and `method` and goes on to
 * `/onboarding/install`. `answers` are the saved onboarding answers (#327), so a refresh resumes
 * with them; `project` is the project being instrumented.
 */
export function Instrument({
  step = 3,
  reached = step,
  answers = {},
  project = "",
}: Partial<StepProps> & { answers?: OnboardingAnswers; project?: string }) {
  const [choice, setChoice] = useState(() => savedInstrument(answers));
  const { go, pending } = useOnboardingContinue(reached);
  const method = effectiveMethod(choice);
  const recommended = recommend(choice.language, choice.runtime);
  const available = methodsFor(choice.language);
  const ok = Boolean(choice.language && choice.runtime && method);

  const languages = LANGUAGES.map((l) => ({ ...l, disabled: !languageEnabled(l) }));
  const soon = languages.filter((l) => l.disabled);
  const methods = METHODS.map((m) => ({ id: m, disabled: !available.includes(m) }));

  const next = () => {
    if (!ok || !method) return;
    // The install step renders from these answers, so it opens once they are saved.
    go("install", "/onboarding/install", { language: choice.language, runtime: choice.runtime, method }, undefined, true);
  };

  return (
    <ObShell
      eyebrow="02:31 AM"
      headline={["Two lines of code,", "every request."]}
      body="Pick how your service reports in. You can add more services and languages later."
      receipt={
        <>
          middleware · <b>1 line</b> · requests, errors and traces
        </>
      }
      progress={60}
      step={step}
      reached={reached}
      badge="code"
      title="How do you want to instrument?"
      lead={
        project ? (
          <>
            Tell us what <b>{project}</b> runs on and we’ll recommend the quickest way in.
          </>
        ) : (
          "Tell us what your service runs on and we’ll recommend the quickest way in."
        )
      }
      footer={<BackNext back="/onboarding/project" nextLabel="Continue" disabled={!ok || pending} loading={pending} onNext={next} />}
    >
      <div className="ob-f">
        <p className="ob-l" id="ins-language">
          Language<small>the service you’re instrumenting first</small>
        </p>
        <RadioGroup
          labelledBy="ins-language"
          className="ob-opts ins-langs"
          items={languages}
          value={choice.language}
          onChange={(id) => setChoice((c) => ({ ...c, language: id }))}
          render={(l, { key, ...props }) => (
            <button key={key} {...props} className={`ob-tile sm ins-tile${props["aria-checked"] ? " on" : ""}`}>
              <Brand src={l.icon} />
              <span className="ins-name">{l.label}</span>
            </button>
          )}
        />
        {soon.length > 0 ? (
          <p className="ins-soon">
            {listOf(soon.map((l) => l.label))} {soon.length === 1 ? "is" : "are"} coming soon.
          </p>
        ) : null}
      </div>
      <div className="ob-f">
        <p className="ob-l" id="ins-runtime">
          Where it runs
        </p>
        <RadioGroup
          labelledBy="ins-runtime"
          className="ob-radios ins-runtimes"
          items={RUNTIMES}
          value={choice.runtime}
          onChange={(id) => setChoice((c) => ({ ...c, runtime: id }))}
          render={(r, { key, ...props }) => (
            <button key={key} {...props} className={`ob-radio ins-radio${props["aria-checked"] ? " on" : ""}`}>
              <span className="rd" />
              {r.label}
              <small>{r.hint}</small>
            </button>
          )}
        />
      </div>
      <div className="ob-f">
        <p className="ob-l" id="ins-method">
          Method
        </p>
        {choice.language ? (
          <RadioGroup
            labelledBy="ins-method"
            className="ob-opts ins-methods"
            items={methods}
            value={method}
            onChange={(id) => setChoice((c) => ({ ...c, method: id as Method }))}
            render={(m, { key, ...props }) => {
              const copy = METHOD_COPY[m.id];
              const later = m.id === "url-check";
              return (
                <button key={key} {...props} className={`ob-opt ins-opt${props["aria-checked"] ? " on" : ""}`}>
                  <span className="ti">
                    <ObIcon name={copy.icon} />
                  </span>
                  <span className="ins-tx">
                    <b>
                      {copy.title}
                      {m.id === recommended ? <span className="ins-tag">Recommended</span> : null}
                      {later ? <span className="ins-tag muted">Later</span> : null}
                    </b>
                    <small>{props["aria-checked"] && choice.runtime ? recommendReason(m.id, choice.language, choice.runtime) : methodDetail(m.id, choice.language)}</small>
                  </span>
                  <span className="mk">{props["aria-checked"] ? <ObIcon name="done" /> : null}</span>
                </button>
              );
            }}
          />
        ) : (
          <div className="ob-note">
            <ObIcon name="info" />
            <span>Pick a language to see the recommended method.</span>
          </div>
        )}
      </div>
    </ObShell>
  );
}
