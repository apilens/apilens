// "Create your first project" (#331): environment names, the organization the project goes into
// and the answer of the create action. The address rules, slugify and the live availability check
// are the organization ones (`org-slug.ts`): project slugs follow the same pattern and are
// globally unique too. No React and no server imports, so it can be unit tested.
import type { ContextOrg, UserContext } from "./identity";

/** The API's environment name rule (`AddEnvironmentInput.Name`). */
export const ENV_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Most environments a project can have (`projects.MaxEnvironments`). */
export const MAX_ENVIRONMENTS = 20;
/** What the screen starts with. */
export const DEFAULT_ENVIRONMENTS = ["production", "staging"];

/** Why an environment entry was not added. */
export type EnvError = "invalid" | "duplicate" | "full";

/**
 * Adds every name in `text` (separated by commas, semicolons or whitespace) to `envs`. Names are
 * trimmed; the first one that is not valid, already there or over the limit stops and is
 * reported, with the names before it added.
 */
export function addEnvironments(envs: string[], text: string): { envs: string[]; error?: EnvError; rejected?: string } {
  const out = [...envs];
  for (const name of text.split(/[\s,;]+/).filter(Boolean)) {
    if (!ENV_NAME.test(name)) return { envs: out, error: "invalid", rejected: name };
    if (out.includes(name)) return { envs: out, error: "duplicate", rejected: name };
    if (out.length >= MAX_ENVIRONMENTS) return { envs: out, error: "full", rejected: name };
    out.push(name);
  }
  return { envs: out };
}

/** A sentence for an environment entry that was not added. */
export function envError(error: EnvError, name: string): string {
  switch (error) {
    case "invalid":
      return `“${name}” isn’t a valid name. Use letters, digits, “.”, “_” and “-”, up to 64 characters.`;
    case "duplicate":
      return `“${name}” is already in the list.`;
    case "full":
      return `A project can have at most ${MAX_ENVIRONMENTS} environments.`;
  }
}

/**
 * The organization the first project is created in: the one created (or picked) on the
 * organization step (`answers.org_slug`) when the user may still create projects in it, else the
 * first such organization. Viewers cannot create projects.
 */
export function projectOrg(ctx: Pick<UserContext, "orgs">, orgSlug?: string): ContextOrg | undefined {
  const usable = ctx.orgs.filter((o) => o.role !== "viewer");
  return usable.find((o) => o.slug === orgSlug) ?? usable[0];
}

/** The create action's answer. */
export type CreateProjectResult =
  | { ok: true; slug: string }
  | { ok: false; code: "slug_taken"; suggestions: string[] }
  | { ok: false; code: string; error: string };

/** A sentence for a failed create, by API error code (slug_taken is shown on the field instead). */
export function createProjectError(code: string): string {
  switch (code) {
    case "invalid_request":
    case "validation_failed":
    case "bad_request":
      return "That name, address or an environment isn’t allowed. Check them and try again.";
    case "forbidden":
      return "You can’t create projects in this organization. Ask an owner or admin.";
    case "rate_limited":
      return "Too many attempts in a row. Wait a moment and try again.";
    case "network_error":
    case "timeout":
    case "unavailable":
      return "We couldn’t reach APILens to create your project. Check your connection and try again.";
    default:
      return "We couldn’t create your project. Try again in a moment.";
  }
}
