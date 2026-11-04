import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccountSettings } from "@/components/account-settings";
import { AppShell } from "@/components/app-shell";
import { getContext } from "@/lib/auth/server";
import { ACCOUNT_SETTINGS, accountSection, accountSectionHref } from "@/lib/account-settings";

type Params = { section?: string[] };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const found = accountSection((await params).section);
  return { title: found ? `${found.label} · ${ACCOUNT_SETTINGS.label}` : ACCOUNT_SETTINGS.label };
}

// Account scope: the signed-in user's own settings, no organization or project in the
// breadcrumb. Section content comes later.
export default async function AccountSettingsPage({ params }: { params: Promise<Params> }) {
  const section = accountSection((await params).section);
  if (!section) notFound();
  const context = await getContext(accountSectionHref(section));
  return (
    <AppShell context={context} view="settings" account>
      <AccountSettings section={section} />
    </AppShell>
  );
}
