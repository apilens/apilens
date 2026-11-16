"use client";

import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";
import type { OnboardingAnswers } from "@/lib/identity";
import { DEFAULT_POSTURE, POSTURES, POSTURE_PARAM, type Posture, privacyDocsUrl } from "@/lib/install";
import { LANGUAGES, RUNTIMES, SDK_METHOD, savedInstrument, sdkReason } from "@/lib/instrument";
import { LINKS, extLink } from "@/lib/links";
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

const POSTURE_ICON: Record<Posture, ObIconName> = { metadata: "lock", redacted: "eye", full: "code" };

/**
 * "What are you instrumenting?" (#332), step 3. Instrumentation is the APILens SDK only, so the
 * step asks for the language (one with an SDK), where it runs, and the capture posture (#601).
 * Continue saves `language`, `runtime` and `method` ("sdk") and goes on to `/onboarding/install`
 * with the posture as `?capture=`, which sets the snippets' `capture_profile`. `answers` are the
 * saved onboarding answers (#327), so a refresh resumes with them; `project` is the project being
 * instrumented; `posture` is the one to start on (from that parameter when coming back).
 */
export function Instrument({
  step = 3,
  reached = step,
  answers = {},
  project = "",
  posture: initialPosture = DEFAULT_POSTURE,
}: Partial<StepProps> & { answers?: OnboardingAnswers; project?: string; posture?: Posture }) {
  const [choice, setChoice] = useState(() => savedInstrument(answers));
  const [posture, setPosture] = useState<Posture>(initialPosture);
  const { go, pending } = useOnboardingContinue(reached);
  const ok = Boolean(choice.language && choice.runtime);

  const next = () => {
    if (!ok) return;
    // The install step renders from these answers, so it opens once they are saved.
    go("install", `/onboarding/install?${POSTURE_PARAM}=${posture}`, { language: choice.language, runtime: choice.runtime, method: SDK_METHOD }, undefined, true);
  };

  return (
    <ObShell
      eyebrow="02:31 AM"
      headline={["Two lines of code,", "every request."]}
      body="The APILens SDK adds one middleware to your service. You can add more services later."
      receipt={
        <>
          middleware · <b>1 line</b> · requests, errors and traces
        </>
      }
      progress={60}
      step={step}
      reached={reached}
      badge="code"
      title="What are you instrumenting?"
      lead={
        project ? (
          <>
            Tell us what <b>{project}</b> is written in and where it runs, and the next step gives you its SDK snippet.
          </>
        ) : (
          "Tell us what your service is written in and where it runs, and the next step gives you its SDK snippet."
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
          items={LANGUAGES}
          value={choice.language}
          onChange={(id) => setChoice((c) => ({ ...c, language: id }))}
          render={(l, { key, ...props }) => (
            <button key={key} {...props} className={`ob-tile sm ins-tile${props["aria-checked"] ? " on" : ""}`}>
              <Brand src={l.icon} />
              <span className="ins-name">{l.label}</span>
            </button>
          )}
        />
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
        {choice.language && choice.runtime ? (
          <div className="ob-note">
            <ObIcon name="info" />
            <span>{sdkReason(choice.language, choice.runtime)}</span>
          </div>
        ) : null}
      </div>
      <div className="ob-f">
        <p className="ob-l" id="ins-posture">
          What the SDK captures<small>change it any time with one setting</small>
        </p>
        <RadioGroup
          labelledBy="ins-posture"
          className="ob-opts ins-methods"
          items={POSTURES}
          value={posture}
          onChange={(id) => setPosture(id as Posture)}
          render={(p, { key, ...props }) => (
            <button key={key} {...props} className={`ob-opt ins-opt${props["aria-checked"] ? " on" : ""}`}>
              <span className="ti">
                <ObIcon name={POSTURE_ICON[p.id]} />
              </span>
              <span className="ins-tx">
                <b>
                  {p.label}
                  {p.id === DEFAULT_POSTURE ? <span className="ins-tag">Recommended</span> : null}
                </b>
                <small>{p.consequence}</small>
              </span>
              <span className="mk">{props["aria-checked"] ? <ObIcon name="done" /> : null}</span>
            </button>
          )}
        />
        <p className="ins-soon">
          The next step’s snippet sets this posture and a starter redaction list.{" "}
          <a className="cp-link" {...extLink(privacyDocsUrl(LINKS.docs))}>
            What each posture sends
          </a>
        </p>
      </div>
    </ObShell>
  );
}
