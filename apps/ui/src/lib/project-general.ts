// Pure helpers for Project settings › General and Danger zone (#805): the limits of
// `PATCH /projects/{slug}` for the name and description (the repository link is Integrations',
// see `repository.ts`), the slug rename (#753 D9), the typed delete confirmation (D8) and the
// restore window. The server re-checks every rule; these only let the form say what is wrong
// before a round trip. No React and no server imports.

import type { DeletedProject, ProjectDetail, UpdateProjectRequest } from "./identity";
import { ORG_SLUG } from "./org-slug";

/** `UpdateProjectInputBody.name`: 1 to 100 characters after trimming. */
export const PROJECT_NAME_MAX = 100;
/** `UpdateProjectInputBody.description` (`projects.MaxDescription`). */
export const PROJECT_DESCRIPTION_MAX = 280;
/** The project slug rule (`RenameProjectInputBody.slug`), the same as organization slugs. */
export const PROJECT_SLUG = ORG_SLUG;

/** What the General form edits, as typed. */
export interface GeneralDraft {
  name: string;
  description: string;
}

export type GeneralErrors = Partial<Record<keyof GeneralDraft, string>>;

/** The draft of a project as it is now. */
export function generalDraftOf(p: Pick<ProjectDetail, "name" | "description">): GeneralDraft {
  return { name: p.name, description: p.description };
}

/**
 * Checks the General form and answers the `PATCH` body with only the fields that changed (empty
 * when nothing did), or a sentence per field that is wrong. Both are trimmed, as the API does.
 */
export function checkGeneral(
  current: Pick<ProjectDetail, "name" | "description">,
  draft: GeneralDraft,
): { ok: true; body: UpdateProjectRequest } | { ok: false; errors: GeneralErrors } {
  const errors: GeneralErrors = {};
  const name = draft.name.trim();
  const description = draft.description.trim();
  if (!name) errors.name = "Enter a project name.";
  else if ([...name].length > PROJECT_NAME_MAX) errors.name = `Use at most ${PROJECT_NAME_MAX} characters.`;
  if ([...description].length > PROJECT_DESCRIPTION_MAX) errors.description = `Use at most ${PROJECT_DESCRIPTION_MAX} characters.`;
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  const body: UpdateProjectRequest = {};
  if (name !== current.name) body.name = name;
  if (description !== current.description) body.description = description;
  return { ok: true, body };
}

/** Why `next` cannot be the project's new slug, or null when it can be asked for. */
export function renameSlugError(current: string, next: string): string | null {
  const s = next.trim();
  if (!s) return "Enter the new project address.";
  if (s === current) return "That is already the project’s address.";
  if (!PROJECT_SLUG.test(s)) return "Use lower-case letters, digits and hyphens, starting with a letter or digit, up to 63 characters.";
  return null;
}

/** Whether the typed confirmation matches the slug exactly, as `DELETE /projects/{slug}` requires. */
export function deleteConfirmed(typed: string, slug: string): boolean {
  return typed === slug;
}

/** Whole days left to restore a deleted project, rounded up; 0 once the purge is due. */
export function restoreDaysLeft(p: Pick<DeletedProject, "purge_after">, now: number = Date.now()): number {
  const ms = Date.parse(p.purge_after) - now;
  return Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 86_400_000) : 0;
}

/** "Restorable for 5 more days", "Restorable until today", "Purge due". */
export function restoreWindowLabel(p: Pick<DeletedProject, "purge_after">, now: number = Date.now()): string {
  const days = restoreDaysLeft(p, now);
  if (days === 0) return "Purge due";
  return days === 1 ? "Restorable until today" : `Restorable for ${days} more days`;
}

/** A sentence for a failed General (`general`) or Danger zone (`danger`) change, by API error code. */
export function projectGeneralError(code: string | undefined, what: "general" | "danger" = "general"): string {
  switch (code) {
    case "invalid_request":
    case "validation_failed":
    case "bad_request":
      return what === "general" ? "Some fields aren’t valid. Check the name and description." : "That address isn’t allowed. Check it and try again.";
    case "slug_immutable":
      return "The project address can’t be changed here. Use Rename in the danger zone.";
    case "slug_taken":
      return "That address is taken or reserved. Try another one.";
    case "confirmation_mismatch":
      return "Type the project’s address exactly to confirm.";
    case "reauth_required":
      return "For your security, sign in again to make this change.";
    case "forbidden":
      return what === "general"
        ? "Only project admins and editors can change this. Ask a project admin."
        : "Only project admins can do this. Ask a project admin.";
    case "not_found":
      return "This project no longer exists, or you no longer have access. Reload the page.";
    case "authz_unavailable":
    case "network_error":
    case "timeout":
    case "unavailable":
      return "We couldn’t reach APILens. Check your connection and try again.";
    default:
      return "Something went wrong. Try again in a moment.";
  }
}
