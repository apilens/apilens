// The project's source repository link (#820, API #791): what Project settings › Integrations
// checks before saving, the commit link it previews, and the commit and release links the Changes
// pages build from the API's URL templates. Pure; safe in Client Components.

/** The API's limit on `repository_url`. */
export const MAX_REPOSITORY_URL = 2048;

/** The hosts the API accepts by default; their commit and release URL layouts are known. */
export const REPOSITORY_HOSTS = ["github.com", "gitlab.com", "bitbucket.org"] as const;

/** The commit the preview links to. */
export const PREVIEW_COMMIT = "4bf92f3";

export type RepositoryCheck = { ok: true; url: string } | { ok: false; error: string };

/**
 * A first check of a repository link as it is typed: empty (removes the link), or an https URL
 * without credentials, query or fragment. The host and path are the API's to judge (an install
 * may allow any host); its reason shows next to the field.
 */
export function checkRepositoryUrl(raw: string): RepositoryCheck {
  const url = raw.trim();
  if (url === "") return { ok: true, url };
  if (url.length > MAX_REPOSITORY_URL) return { ok: false, error: `The repository link must be at most ${MAX_REPOSITORY_URL} characters.` };
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, error: "Enter the repository’s web address, like https://github.com/acme/shop." };
  }
  if (u.protocol !== "https:") return { ok: false, error: "The repository link must start with https://." };
  if (u.username || u.password || u.search || u.hash || url.endsWith("?") || url.endsWith("#")) {
    return { ok: false, error: "The repository link must not carry credentials, a query or a fragment." };
  }
  return { ok: true, url };
}

/** The commit URL template the API derives for a link, or null when its host's layout is unknown. */
export function commitTemplateOf(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  const path = u.pathname.replace(/\/+$/, "").replace(/\.git$/, "").replace(/\/+$/, "");
  const base = `https://${u.host.toLowerCase()}${path}`;
  switch (u.host.toLowerCase()) {
    case "github.com":
      return `${base}/commit/{commit}`;
    case "gitlab.com":
      return `${base}/-/commit/{commit}`;
    case "bitbucket.org":
      return `${base}/commits/{commit}`;
    default:
      return null;
  }
}

/** The link a template gives a commit id, or null without a template or id. */
export function commitHref(template: string | null | undefined, commit: string | null | undefined): string | null {
  return template && commit ? template.replaceAll("{commit}", encodeURIComponent(commit)) : null;
}

/** The link a template gives a release name, or null without a template or name. */
export function releaseHref(template: string | null | undefined, release: string | null | undefined): string | null {
  return template && release ? template.replaceAll("{release}", encodeURIComponent(release)) : null;
}

/** A sentence for an API error code of `PATCH /projects/{slug}`; `detail` is the API's reason. */
export function repositoryError(code: string | undefined, detail?: string): string {
  switch (code) {
    case "invalid_request":
      return detail || "That repository link wasn’t accepted. Check it and try again.";
    case "forbidden":
      return "You can view this project’s settings but not change them.";
    case "not_found":
      return "This project no longer exists, or you no longer have access to it.";
    case "authz_unavailable":
      return "Permissions can’t be checked right now. Try again in a moment.";
    default:
      return "Couldn’t save the repository link. Try again in a moment.";
  }
}
