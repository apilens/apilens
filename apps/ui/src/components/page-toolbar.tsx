import type { ReactNode } from "react";
import "./page-toolbar.css";

/**
 * The one page toolbar (#1051): a single 32px row under the title row (and the view tabs, when a
 * page has them), in the same order on every page:
 *
 *   range · scope (app / environment) · filters · ⟷ · secondary actions · primary action
 *
 * Every slot is optional; an empty one leaves no gap. Controls in it share one height
 * (`--control-h`, 32px) and radius (`--radius-control`, 6px). On phones the row wraps, and the
 * actions keep to the right.
 */
export function PageToolbar({
  range,
  scope,
  filters,
  secondary,
  primary,
  className,
}: {
  range?: ReactNode;
  scope?: ReactNode;
  filters?: ReactNode;
  secondary?: ReactNode;
  primary?: ReactNode;
  className?: string;
}) {
  const end = secondary || primary;
  return (
    <div className={["pt", className].filter(Boolean).join(" ")}>
      {range ? <div className="pt-range">{range}</div> : null}
      {scope ? <div className="pt-scope">{scope}</div> : null}
      {filters ? <div className="pt-filters">{filters}</div> : null}
      {end ? (
        <div className="pt-end">
          {secondary}
          {primary}
        </div>
      ) : null}
    </div>
  );
}
