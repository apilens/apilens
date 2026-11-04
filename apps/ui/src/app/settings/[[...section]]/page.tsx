import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccountSettings } from "@/components/account-settings";
import { SessionsSettings } from "@/components/account-settings/sessions";
import { AppShell } from "@/components/app-shell";
import { getContext, getSession } from "@/lib/auth/server";
import { ACCOUNT_SETTINGS, accountSection, accountSectionHref } from "@/lib/account-settings";
import { type SessionInfo, identity } from "@/lib/identity";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";

type Params = { section?: string[] };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const found = accountSection((await params).section);
  return { title: found ? `${found.label} · ${ACCOUNT_SETTINGS.label}` : ACCOUNT_SETTINGS.label };
}

/** `GET /users/me/sessions`: the signed-in user's live sessions. */
async function loadSessions(next: string): Promise<SessionInfo[]> {
  const session = await getSession();
  try {
    return (await session.call((o) => identity().listSessions(o))).sessions;
  } catch (err) {
    if (isSessionExpired(err)) redirectToRefresh(next);
    throw err;
  }
}

// Account scope: the signed-in user's own settings, no organization or project in the
// breadcrumb. Sections without content yet show only their title.
export default async function AccountSettingsPage({ params }: { params: Promise<Params> }) {
  const section = accountSection((await params).section);
  if (!section) notFound();
  const next = accountSectionHref(section);
  const context = await getContext(next);
  const sessions = section.slug === "sessions" ? await loadSessions(next) : null;
  return (
    <AppShell context={context} view="settings" account>
      <AccountSettings section={section}>
        {/* `now` is taken here so server and browser render the same "last active" text. */}
        {sessions ? <SessionsSettings sessions={sessions} now={Date.now()} /> : null}
      </AccountSettings>
    </AppShell>
  );
}
