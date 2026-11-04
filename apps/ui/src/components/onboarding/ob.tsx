import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/logo";
import { LINKS, extLink } from "@/lib/links";

// 16px onboarding icons from the design system's Flow previews (1.5 stroke, set by .ob-ic).
const P = {
  user: <><circle cx="8" cy="5.5" r="2.75" /><path d="M2.5 14c.6-2.9 2.8-4.5 5.5-4.5s4.9 1.6 5.5 4.5" /></>,
  building: <path d="M3 14V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1V14M10 6.5h2a1 1 0 0 1 1 1V14M1.5 14h13M5.5 5h2M5.5 8h2M5.5 11h2" />,
  folder: <path d="M1.75 4.5A1.5 1.5 0 0 1 3.25 3h3l1.5 1.75h5a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-9.5a1.5 1.5 0 0 1-1.5-1.5z" />,
  code: <path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5M9 3 7 13" />,
  live: <><circle cx="8" cy="8" r="1.5" /><path d="M5.2 5.2a4 4 0 0 0 0 5.6M10.8 5.2a4 4 0 0 1 0 5.6M3.2 3.2a6.8 6.8 0 0 0 0 9.6M12.8 3.2a6.8 6.8 0 0 1 0 9.6" /></>,
  book: <path d="M2.5 3.5c1.8-.9 3.8-.9 5.5.5v9c-1.7-1.4-3.7-1.4-5.5-.5zM13.5 3.5c-1.8-.9-3.8-.9-5.5.5v9c1.7-1.4 3.7-1.4 5.5-.5z" />,
  help: <><circle cx="8" cy="8" r="6.25" /><path d="M6.3 6.2a1.8 1.8 0 0 1 3.5.6c0 1.2-1.8 1.4-1.8 2.6M8 11.4v.1" /></>,
  mail: <><rect x="1.75" y="3.25" width="12.5" height="9.5" rx="2" /><path d="m2.5 4.5 5.5 4.25 5.5-4.25" /></>,
  lock: <><rect x="3" y="7" width="10" height="7" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></>,
  finger: <path d="M4.6 3.3A6 6 0 0 1 14 8.2v1M2.2 6.4A6 6 0 0 1 3.4 4.4M2 9.6v-1.4M5.4 13.8C4.6 12.4 4.3 10.8 4.3 8.5a3.7 3.7 0 0 1 7.4 0v.9M8 8.5c0 2.6.5 4.4 1.6 5.9M11.7 11.6c-.1.9-.3 1.7-.6 2.4M6.2 8.6c0 2.2.3 3.8 1 5.2" />,
  eye: <><path d="M1.5 8s2.4-4.75 6.5-4.75S14.5 8 14.5 8s-2.4 4.75-6.5 4.75S1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /></>,
  team: <path d="M10.5 3.2a2.5 2.5 0 0 1 0 4.6M12.3 9.9c1.2.6 2 1.8 2.2 3.6M1.5 13.5c.4-2.4 2.2-3.8 4.5-3.8s4.1 1.4 4.5 3.8M8.5 5.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z" />,
  info: <><circle cx="8" cy="8" r="6.25" /><path d="M8 7.2v4M8 4.9v.1" /></>,
  done: <><circle cx="8" cy="8" r="6.25" /><path d="m5.3 8.2 1.9 1.9 3.6-3.8" /></>,
  next: <path d="M3 8h10M9 4l4 4-4 4" />,
  back: <path d="M13 8H3M7 4 3 8l4 4" />,
  link: <path d="m6.5 9.5 3-3M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1" />,
  out: <path d="M9 2.5h4.5V7M13.5 2.5l-6 6M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" />,
  redo: <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" />,
} as const;
export type ObIconName = keyof typeof P;

/** An `aria-describedby` value from the ids that apply (falsy ones are skipped), or undefined. */
export function describedBy(...ids: (string | false | null | undefined)[]): string | undefined {
  return ids.filter(Boolean).join(" ") || undefined;
}

export function ObIcon({ name }: { name: ObIconName }) {
  return (
    <svg className="ob-ic" viewBox="0 0 16 16" aria-hidden="true">
      {P[name]}
    </svg>
  );
}

const STEPS: { label: string; icon: ObIconName }[] = [
  { label: "Account", icon: "user" },
  { label: "Organization", icon: "building" },
  { label: "Project", icon: "folder" },
  { label: "Instrument", icon: "code" },
  { label: "Go live", icon: "live" },
];

function Steps({ current, reached = current }: { current: number; reached?: number }) {
  const upTo = Math.max(current, reached);
  return (
    <nav className="ob-steps" aria-label="Setup progress">
      {STEPS.map((s, i) => {
        const state = i === current ? "cur" : i < upTo ? "done" : "todo";
        return (
          <span key={s.label} style={{ display: "contents" }}>
            {i > 0 ? <span className={`ob-sep${i <= upTo ? " done" : ""}`} /> : null}
            <span className={`ob-st ${state}`} aria-current={state === "cur" ? "step" : undefined}>
              <ObIcon name={state === "done" ? "done" : s.icon} />
              {s.label}
            </span>
          </span>
        );
      })}
    </nav>
  );
}

export interface ObProps {
  /** Brand panel: mono eyebrow, headline lines, one human line, one receipt. */
  eyebrow: string;
  headline: string[];
  body: string;
  receipt: ReactNode;
  /** 0–100 position on the 02:14 to 02:44 timeline. Omit for sign in. */
  progress?: number;
  /** Index of the current setup step. Omit for sign in. */
  step?: number;
  /** Index of the furthest saved setup step; earlier steps show as done. Defaults to `step`. */
  reached?: number;
  badge: ObIconName;
  title: string;
  lead: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  below?: ReactNode;
}

/**
 * The onboarding split layout: brand panel (560px) on the left, the form on the right. The form
 * comes first in the DOM (the grid puts the panel back on the left), so keyboard and screen-reader
 * order reach the form and its `h1` before the brand panel's `h2` and footer links.
 */
export function ObShell({ eyebrow, headline, body, receipt, progress, step, reached, badge, title, lead, children, footer, below }: ObProps) {
  return (
    <div className="ah ob2">
      <main className="ob-fp">
        <div className="ob-ftop">
          <span className="ob-mlogo"><Logo height={34} /></span>
          {step !== undefined ? <Steps current={step} reached={reached} /> : <span />}
          <div className="ob-tr">
            <a className="ah-btn ah-btn--ghost ah-btn--sm" {...extLink(LINKS.docs)} title="Docs" aria-label="Docs">
              <ObIcon name="book" />
              Docs
            </a>
            <a className="ah-btn ah-btn--ghost ah-btn--sm" {...extLink(LINKS.help)} title="Help" aria-label="Help">
              <ObIcon name="help" />
              Help
            </a>
          </div>
        </div>
        <div className="ob-fbody">
          <div className="ob-col">
            <div className="ob-badge">
              <ObIcon name={badge} />
            </div>
            <h1 className="ob-h">{title}</h1>
            <p className="ob-p">{lead}</p>
            {children}
          </div>
        </div>
        {footer ? (
          <div className="ob-col" style={{ width: "100%" }}>
            {footer}
          </div>
        ) : null}
        {below ? (
          <div className="ob-col" style={{ width: "100%" }}>
            <p className="ob-p ob-below">{below}</p>
          </div>
        ) : null}
      </main>

      <aside className="ob-bp" aria-label="About APILens">
        <div className="ob-bp-top">
          <Logo height={44} />
        </div>
        <div className="ob-bp-mid">
          <div className="ob-eb">{eyebrow}</div>
          <h2>
            {headline.map((l, i) => (
              <span key={i}>
                {l}
                {i < headline.length - 1 ? <br /> : null}
              </span>
            ))}
          </h2>
          <p>{body}</p>
          <div className="ob-rc">{receipt}</div>
        </div>
        {progress !== undefined ? (
          <div className="ob-tl" aria-hidden="true">
            <span>02:14</span>
            <span className="tr">
              <span className="fill" style={{ width: `${progress}%` }} />
              <span className="dot" style={{ left: `${progress}%` }} />
            </span>
            <span>02:44</span>
          </div>
        ) : null}
        <div className="ob-bp-foot">
          <span>© 2026 APILens</span>
          <a {...extLink(LINKS.privacy)}>Privacy</a>
          <a {...extLink(LINKS.terms)}>Terms</a>
          <a {...extLink(LINKS.status)}>Status</a>
        </div>
      </aside>
    </div>
  );
}

/** Step bar state an onboarding page gets from its server guard (`requireOnboardingStep`). */
export interface StepProps {
  step: number;
  reached: number;
}

export function BackNext({ back, next, nextLabel, disabled, onNext, loading }: { back?: string; next?: string; nextLabel: string; disabled?: boolean; onNext?: () => void; loading?: boolean }) {
  const primaryClass = `ah-btn ah-btn--primary${disabled ? " is-disabled" : ""}${loading ? " is-loading" : ""}`;
  return (
    <div className="ob-foot">
      {back ? (
        <Link className="ah-btn ah-btn--ghost" href={back}>
          <ObIcon name="back" />
          Back
        </Link>
      ) : null}
      <span className="sp" />
      {next ? (
        <Link className={primaryClass} href={next} aria-disabled={disabled || undefined}>
          {nextLabel}
          <ObIcon name="next" />
        </Link>
      ) : (
        <button type="button" className={primaryClass} onClick={onNext} disabled={disabled} aria-disabled={disabled || undefined}>
          {nextLabel}
          <ObIcon name="next" />
        </button>
      )}
    </div>
  );
}

/** A provider logo. Without `label` it is decorative: the button around it already names it. */
export const Brand = ({ src, label }: { src: string; label?: string }) => (
  <span
    className="al-brand"
    style={{ ["--src" as string]: `url(https://cdn.jsdelivr.net/npm/simple-icons@13.21.0/icons/${src}.svg)`, width: 16, height: 16 }}
    {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
  />
);
