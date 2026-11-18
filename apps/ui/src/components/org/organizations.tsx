import Link from "next/link";
import { orgHref } from "@/lib/routes";
import { type ContextOrg, orgMark, plural, roleLabel } from "@/lib/scope";
import "../org-settings/org-settings.css";
import "./org.css";

/**
 * `/organizations` (Supabase's): every organization you belong to, with your role and how many
 * of its projects you can see; each opens the organization's projects (`/org/<org>`).
 */
export function Organizations({ orgs }: { orgs: ContextOrg[] }) {
  return (
    <div className="page os org-page">
      <header className="os-pagehead">
        <div>
          <p className="cp-h">Account</p>
          <h1 className="cp-lede">Your organizations</h1>
        </div>
      </header>

      <p className="org-count">{plural(orgs.length, "organization")}</p>
      <ul className="org-grid" aria-label="Organizations">
        {orgs.map((o) => (
          <li key={o.slug}>
            <Link href={orgHref(o.slug)} className="org-card">
              <span className="st-mark org-card__mark" aria-hidden="true">
                {orgMark(o)}
              </span>
              <span className="org-card__t">
                <b>{o.name}</b>
                <code>{o.slug}</code>
              </span>
              <span className="org-card__meta">
                <span>{plural(o.projects.length, "project")}</span>
                <span className="org-badge">{roleLabel(o.role)}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
