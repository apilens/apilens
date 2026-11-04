import Link from "next/link";
import { ORG_SETTINGS_SECTIONS, orgSettingsHref } from "@/lib/org-settings";

/** The organization settings' pages as a row of tabs under the title; `current` is a section slug. */
export function OrgSettingsNav({ org, current }: { org: string; current: string }) {
  return (
    <nav className="os-tabs" aria-label="Organization settings">
      {ORG_SETTINGS_SECTIONS.map((s) => {
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
