import Link from "next/link";
import type { OrgRole } from "@/lib/identity";
import { orgSettingsHref, orgSettingsSections } from "@/lib/org-settings";

/**
 * The organization settings' pages as a row of tabs under the title; `current` is a section slug.
 * `role` hides the sections it may not open (the Audit log for members and viewers).
 */
export function OrgSettingsNav({ org, current, role }: { org: string; current: string; role: OrgRole }) {
  return (
    <nav className="os-tabs" aria-label="Organization settings">
      {orgSettingsSections(role).map((s) => {
        const on = s.slug === current;
        return (
          <Link key={s.slug} href={orgSettingsHref(org, s)} className={`os-tab${on ? " on" : ""}`} aria-current={on ? "page" : undefined}>
            {s.label}
          </Link>
        );
      })}
    </nav>
  );
}
