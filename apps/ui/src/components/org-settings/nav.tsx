import Link from "next/link";
import type { ReactNode } from "react";
import type { OrgRole } from "@/lib/identity";
import { type OrgSettingsSection, orgSettingsHref, orgSettingsSections } from "@/lib/org-settings";

/**
 * Organization settings' frame, Supabase style: the settings menu on the left (General, SSO and,
 * for owners and admins, Audit log; a row of tabs below 860px) and the section under its title.
 * `role` hides the sections it may not open; `measure` caps the content at the reading width
 * (form pages).
 */
export function OrgSettingsFrame({
  org,
  role,
  current,
  title,
  measure = false,
  className,
  children,
}: {
  org: string;
  role: OrgRole;
  current: OrgSettingsSection["slug"];
  title: string;
  measure?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={["page os", className].filter(Boolean).join(" ")}>
      <div className="acct-body">
        <nav className="acct-nav osf-nav" aria-label="Organization settings">
          <p className="osf-label">Organization settings</p>
          <ul>
            {orgSettingsSections(role).map((s) => {
              const on = s.slug === current;
              return (
                <li key={s.slug}>
                  <Link href={orgSettingsHref(org, s)} className={`cp-sitem${on ? " on" : ""}`} aria-current={on ? "page" : undefined}>
                    <span className="lb">{s.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <section className={`acct-main${measure ? " osf-measure" : ""}`} aria-labelledby="osf-title">
          <h1 id="osf-title" className="cp-lede osf-title">
            {title}
          </h1>
          {children}
        </section>
      </div>
    </div>
  );
}
