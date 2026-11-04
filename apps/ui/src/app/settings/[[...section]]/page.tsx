import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccountSettings } from "@/components/account-settings";
import { SessionsSettings } from "@/components/account-settings/sessions";
import { AppShell } from "@/components/app-shell";
import { ConnectedAccounts } from "@/components/connected-accounts";
import { getContext, getSession } from "@/lib/auth/server";
import { ACCOUNT_SETTINGS, type AccountSection, accountSection, accountSectionHref } from "@/lib/account-settings";
import { connectedNotice, providerRows } from "@/lib/connected-accounts";
import { type ConnectedAccount, type SessionInfo, type UserContext, identity } from "@/lib/identity";
import { isSessionExpired, redirectToRefresh } from "@/lib/server-session";
import { signInMethods } from "@/lib/sign-in-providers";

type Params = { section?: string[] };
type Search = Record<string, string | string[] | undefined>;

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

/** `GET /users/me/identities`: the Google and GitHub accounts connected to the user. */
async function loadConnectedAccounts(next: string): Promise<ConnectedAccount[]> {
  const session = await getSession();
  try {
    return (await session.call((o) => identity().listIdentities(o))).identities ?? [];
  } catch (err) {
    if (isSessionExpired(err)) redirectToRefresh(next);
    throw err;
  }
}

/** The section's own content under its title; null for sections still to come. */
async function sectionContent(section: AccountSection, context: UserContext, search: Search) {
  const next = accountSectionHref(section);
  if (section.slug === "sessions") {
    const sessions = await loadSessions(next);
    // `now` is taken here so server and browser render the same "last active" text.
    return <SessionsSettings sessions={sessions} now={Date.now()} />;
  }
  if (section.slug === "connected-accounts") {
    const [accounts, methods] = await Promise.all([loadConnectedAccounts(next), signInMethods()]);
    return <ConnectedAccounts rows={providerRows(methods, accounts)} email={context.user.email} notice={connectedNotice(search)} />;
  }
  return null;
}

// Account scope: the signed-in user's own settings, no organization or project in the
// breadcrumb. Sections without content yet show only their title.
export default async function AccountSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<Params>;
  searchParams: Promise<Search>;
}) {
  const section = accountSection((await params).section);
  if (!section) notFound();
  const context = await getContext(accountSectionHref(section));
  const content = await sectionContent(section, context, await searchParams);
  return (
    <AppShell context={context} view="settings" account>
      <AccountSettings section={section}>{content}</AccountSettings>
    </AppShell>
  );
}
