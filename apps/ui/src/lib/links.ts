// Public links shown on the auth and onboarding shell (footer, top bar, sign-up fine print).
// Defaults point at apilens.ai; self-hosted installs override any of them at build time with
// APILENS_LINKS_TERMS, APILENS_LINKS_PRIVACY, APILENS_LINKS_STATUS, APILENS_LINKS_DOCS and
// APILENS_LINKS_HELP (passed through to the client bundle by next.config.ts).

export interface PublicLinks {
  terms: string;
  privacy: string;
  status: string;
  docs: string;
  help: string;
}

const pick = (value: string | undefined, fallback: string) => (value && value.trim() ? value.trim() : fallback);

// Each variable is read with a literal `process.env.X` so Next inlines it into client components.
export const LINKS: PublicLinks = {
  terms: pick(process.env.APILENS_LINKS_TERMS, "https://apilens.ai/terms"),
  privacy: pick(process.env.APILENS_LINKS_PRIVACY, "https://apilens.ai/privacy"),
  status: pick(process.env.APILENS_LINKS_STATUS, "https://status.apilens.ai"),
  docs: pick(process.env.APILENS_LINKS_DOCS, "https://apilens.ai/docs"),
  help: pick(process.env.APILENS_LINKS_HELP, "https://apilens.ai/help"),
};

/** Anchor props for a public link: external URLs open in a new tab without a referrer. */
export function extLink(href: string) {
  return /^https?:\/\//i.test(href) ? { href, target: "_blank", rel: "noreferrer" } : { href };
}
