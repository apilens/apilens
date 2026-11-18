import type { ReactNode } from "react";
import { ObIcon } from "./onboarding/ob";
import "./states.css";

/**
 * The shared page states (#1051): one empty, one loading and one error state, so every page says
 * "nothing here", "loading" and "that failed" the same way. Tokens from tokens.css only.
 *
 * - EmptyState: a status line (`role="status"`) with an optional next step in `children`.
 * - ErrorState: an alert (`role="alert"`): `text`, then "Try again" linking `href` (the page again).
 * - LoadingState: skeleton blocks for a page's content while it loads (`aria-busy`), named by
 *   `label` for assistive tech; `variant` picks the shape (a table's rows, a settings form's cards,
 *   or a dashboard's tiles and chart). Every section's `loading.tsx` renders one.
 */
export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="st-note" role="status">
      <ObIcon name="info" />
      <p>{children}</p>
    </div>
  );
}

export function ErrorState({ text, href }: { text: ReactNode; href?: string }) {
  return (
    <div className="st-note st-note--error" role="alert">
      <ObIcon name="info" />
      <p>
        {text}
        {href ? (
          <>
            {" "}
            <a className="cp-link" href={href}>
              Try again
            </a>
          </>
        ) : null}
      </p>
    </div>
  );
}

export function LoadingState({ label, variant = "rows" }: { label: string; variant?: "rows" | "form" | "dashboard" }) {
  return (
    <div className="st-loading" aria-busy="true" aria-live="polite" data-variant={variant}>
      <p className="st-sr">{label}</p>
      {variant === "dashboard" ? (
        <>
          <div className="st-tiles">
            <span className="st-block st-tile" />
            <span className="st-block st-tile" />
            <span className="st-block st-tile" />
            <span className="st-block st-tile" />
          </div>
          <span className="st-block st-chart" />
        </>
      ) : variant === "form" ? (
        <>
          <span className="st-block st-card" />
          <span className="st-block st-card st-card--short" />
        </>
      ) : (
        <div className="st-rows">
          {Array.from({ length: 8 }, (_, i) => (
            <span key={i} className="st-block st-row" />
          ))}
        </div>
      )}
    </div>
  );
}
