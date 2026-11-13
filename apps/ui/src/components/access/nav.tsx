import Link from "next/link";
import { type AccessTab, accessHref } from "@/lib/access";
import "../org-settings/org-settings.css";

/** The Access page's tabs under the title (#801); `tabs` are the ones the user may see, `current` is a tab slug. */
export function AccessNav({ project, tabs, current }: { project: string; tabs: readonly AccessTab[]; current: string }) {
  return (
    <nav className="os-tabs" aria-label="Access">
      {tabs.map((t) => {
        const on = t.slug === current;
        return (
          <Link key={t.slug} href={accessHref(project, t)} className={`os-tab${on ? " on" : ""}`} aria-current={on ? "page" : undefined}>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
