// Pure helpers for Project settings › Environments (#805, #753 D11): the API's name rule and
// limit, the fixed colour palette, the order, and why an environment can only be hidden. The
// server re-checks every rule; these only shape what the UI offers. No React and no server imports.

import type { Environment, EnvironmentColor } from "./identity";
import { ENV_NAME, MAX_ENVIRONMENTS } from "./project-create";

export { ENV_NAME, MAX_ENVIRONMENTS };

/** The fixed palette (`projects.Colors`), in picker order. */
export const ENVIRONMENT_COLORS: readonly EnvironmentColor[] = ["gray", "red", "orange", "yellow", "green", "teal", "blue", "purple"];

export const ENVIRONMENT_COLOR_LABELS: Record<EnvironmentColor, string> = {
  gray: "Gray",
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  teal: "Teal",
  blue: "Blue",
  purple: "Purple",
};

/** Whether `v` is a palette colour. */
export function isEnvironmentColor(v: unknown): v is EnvironmentColor {
  return typeof v === "string" && (ENVIRONMENT_COLORS as readonly string[]).includes(v);
}

/**
 * Why `name` cannot be added, or null. Mirrors `POST /projects/{slug}/environments`: the name
 * rule and at most `max` environments. A name the project already has is reported here although
 * the API would accept it and change nothing.
 */
export function newEnvironmentError(name: string, existing: readonly Pick<Environment, "name">[], max: number = MAX_ENVIRONMENTS): string | null {
  const s = name.trim();
  if (!s) return "Enter an environment name.";
  if (!ENV_NAME.test(s)) return "Use letters, digits, “.”, “_” and “-”, starting with a letter or digit, up to 64 characters.";
  if (existing.some((e) => e.name === s)) return `This project already has “${s}”.`;
  if (existing.length >= max) return `A project can have at most ${max} environments. Remove one first.`;
  return null;
}

/** The environments in the project's order (by `position`, then name). */
export function inOrder<T extends Pick<Environment, "name" | "position">>(envs: readonly T[]): T[] {
  return [...envs].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
}

/** The visible ones, in order: what pickers show by default. */
export function visibleEnvironments<T extends Pick<Environment, "name" | "position" | "hidden">>(envs: readonly T[]): T[] {
  return inOrder(envs).filter((e) => !e.hidden);
}

/**
 * The names in their new order after moving `name` to index `to` (clamped), the body of
 * `PUT /projects/{slug}/environments/order`. An unknown name leaves the order as it is.
 */
export function moveEnvironment(names: readonly string[], name: string, to: number): string[] {
  const from = names.indexOf(name);
  if (from < 0) return [...names];
  const out = names.filter((n) => n !== name);
  out.splice(Math.max(0, Math.min(to, out.length)), 0, name);
  return out;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Why the environment cannot be removed (hide it instead), or null when it can. The reasons the
 * API gives `environment_in_use` for: data within retention, pinned API keys, health checks.
 */
export function removeBlocker(env: Pick<Environment, "deletable" | "has_data" | "api_keys" | "health_checks">): string | null {
  if (env.deletable) return null;
  const reasons: string[] = [];
  if (env.has_data) reasons.push("it has data");
  if (env.api_keys > 0) reasons.push(`${plural(env.api_keys, "API key is", "API keys are")} pinned to it`);
  if (env.health_checks > 0) reasons.push(`${plural(env.health_checks, "health check uses", "health checks use")} it`);
  const why = reasons.length > 0 ? reasons.join(", ") : "it is in use";
  return `Can’t be removed because ${why}. Hide it instead.`;
}

/** Where an environment came from, in words. */
export function sourceLabel(source: Environment["source"]): string {
  return source === "sdk" ? "Reported by an SDK" : "Added in the dashboard";
}

/** A sentence for a failed environment change, by API error code. */
export function environmentError(code: string | undefined): string {
  switch (code) {
    case "invalid_request":
    case "validation_failed":
    case "bad_request":
      return `Check the name (letters, digits, “.”, “_” and “-”, up to 64 characters). A project can have at most ${MAX_ENVIRONMENTS} environments.`;
    case "environment_in_use":
      return "This environment has data, a pinned API key or a health check, so it can’t be removed. Hide it instead.";
    case "not_found":
      return "That environment no longer exists. Reload the page to see the current list.";
    case "forbidden":
      return "Only project admins and editors can change environments. Ask a project admin.";
    case "authz_unavailable":
    case "network_error":
    case "timeout":
    case "unavailable":
      return "We couldn’t reach APILens. Check your connection and try again.";
    default:
      return "Something went wrong. Try again in a moment.";
  }
}
