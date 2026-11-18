import type { ReactNode } from "react";
import { ACCOUNT_SETTINGS, type AccountSection } from "@/lib/account-settings";
import { PageHeader } from "./page-header";

/**
 * An account settings section's page (#1051): the page anatomy's title row (Account settings, the
 * section menu's header) with the section's name and summary under it, then `children`. The
 * section menu itself comes from `app/settings/layout.tsx`.
 */
export function AccountSettings({ section, children }: { section: AccountSection; children?: ReactNode }) {
  return (
    <div className="page page--narrow acct">
      <PageHeader title={ACCOUNT_SETTINGS.label} lead={ACCOUNT_SETTINGS.lead} section={section.label}>
        <p className="cp-sub">{section.summary}</p>
      </PageHeader>
      {children}
    </div>
  );
}
