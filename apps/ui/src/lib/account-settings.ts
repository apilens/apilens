// The account section (`/settings/*`): the signed-in user's own settings, independent of any
// organization or project. Pure; safe in Client Components.

export interface AccountSection {
  /** URL segment under `/settings`; empty for the section `/settings` itself opens. */
  slug: string;
  label: string;
  /** One line under the section title. */
  summary: string;
}

/** Account-level page, opened from the account menu: lives at /settings. */
export const ACCOUNT_SETTINGS = { label: "Account settings", crumb: "Account", lead: "Your profile, how you sign in, and the devices signed in to your account." } as const;

export const ACCOUNT_SECTIONS: readonly AccountSection[] = [
  { slug: "", label: "Profile", summary: "Your name, email address and time zone." },
  { slug: "security", label: "Security", summary: "Passkeys, two-factor authentication and recovery codes." },
  { slug: "sessions", label: "Sessions", summary: "Devices signed in to your account." },
  { slug: "connected-accounts", label: "Connected accounts", summary: "Sign-in providers linked to your account." },
  { slug: "preferences", label: "Preferences", summary: "What a project opens on when you sign in." },
  { slug: "danger", label: "Danger zone", summary: "Delete your account." },
];

/** The section a `/settings/[[...section]]` route points at; undefined means 404. */
export function accountSection(section: string[] | undefined): AccountSection | undefined {
  if (!section || section.length === 0) return ACCOUNT_SECTIONS[0];
  if (section.length > 1 || section[0] === "") return undefined;
  return ACCOUNT_SECTIONS.find((s) => s.slug === section[0]);
}

/** `/settings` or `/settings/<slug>`. */
export function accountSectionHref(s: Pick<AccountSection, "slug">): string {
  return s.slug ? `/settings/${s.slug}` : "/settings";
}
