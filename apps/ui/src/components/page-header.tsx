import { Children, type ReactNode, isValidElement } from "react";
import "./page-header.css";

/** The plain text of a node (strings and numbers, through fragments and elements), for a tooltip. */
function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return Children.toArray(node.props.children).map(textOf).join("");
  return "";
}

/**
 * The title row of the one page anatomy (#992, #1051): title row → optional view tabs → optional
 * toolbar → content, `--stack-gap` apart, inside a `.page` (full) or `.page page--narrow` frame.
 *
 * - `title` is the H1, 20px/28px: the page's nav label (the rail's, or the section menu's header),
 *   so nav, H1 and browser title use the same words.
 * - `lead` is the one-line description under it, 14px muted; it truncates, with the full text in
 *   a tooltip.
 * - `actions` sit at the row's right edge: the page's primary buttons ("New rule", "Invite").
 *   Range pickers and filters belong in the PageToolbar under the row, not here.
 * - `badge` sits after the title (a count or a state).
 * - `section` names a sub-page under the row (a settings section, a rule): an H2.
 * - `children` render under it all (a section's own lead with links).
 *
 * There is no eyebrow: the top bar's crumbs already name the project and organization.
 * `project` and `projectName` are accepted and ignored (they fed the old eyebrow) until every
 * caller, Explore's among them (#1052), stops passing them. `className` stays for callers' hooks.
 */
export function PageHeader({
  title,
  section,
  lead,
  actions,
  badge,
  className = "pagehead",
  children,
}: {
  /** @deprecated The top bar names the project; ignored. */
  project?: string;
  /** @deprecated The top bar names the project; ignored. */
  projectName?: string;
  title: string;
  section?: string;
  lead?: ReactNode;
  actions?: ReactNode;
  badge?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  const tip = textOf(lead).trim();
  return (
    <header className={`ph ${className}`}>
      <div className="ph-row">
        <div className="ph-text">
          <div className="ph-titleline">
            <h1 className="cp-lede ph-title">{title}</h1>
            {badge ? <span className="ph-badge">{badge}</span> : null}
          </div>
          {lead ? (
            <p className="ph-lead" title={tip || undefined}>
              {lead}
            </p>
          ) : null}
        </div>
        {actions ? <div className="ph-actions">{actions}</div> : null}
      </div>
      {section ? <h2 className="ph-section">{section}</h2> : null}
      {children}
    </header>
  );
}
