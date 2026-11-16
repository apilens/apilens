// Smart scope defaults (#993, decision D4 of #963). When the URL has no `range`, a page reads the
// smallest of 1h / 6h / 24h / 7d that covers the project's first data (from its ingest status), so
// a young project's traffic fills the chart instead of sitting in its last few percent. When the
// URL has no `env`, the page reads `production` when the project has it, else its first
// environment; the browser then restores the last environment chosen for the project (kept in
// localStorage). `env=all` is the explicit "All environments" choice. Pure; safe in Client
// Components.
import type { QueryRange } from "./identity";

/** The ranges a smart default chooses from, smallest first. */
export const SMART_RANGES: readonly QueryRange[] = ["1h", "6h", "24h", "7d"];

/** How long each range reaches back, in milliseconds. */
const RANGE_MS: Record<QueryRange, number> = { "1h": 3_600_000, "6h": 21_600_000, "24h": 86_400_000, "7d": 604_800_000 };

/** The `env` value that means every environment (the page state's ""). */
export const ENV_ALL = "all";

/** The environment the page reads by default: `production` when the project has it, else its first. */
export const PREFERRED_ENV = "production";

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * The smallest range in `options` (of 1h / 6h / 24h / 7d) that covers data first seen at
 * `firstAt`, as of `now`. Data older than every range gets the largest; no data (or a time that
 * does not parse) gets `fallback`, the page's own default.
 */
export function chooseRange(firstAt: string | null | undefined, now: number, options: readonly QueryRange[], fallback: QueryRange): QueryRange {
  const candidates = SMART_RANGES.filter((r) => options.includes(r));
  if (!firstAt || candidates.length === 0) return fallback;
  const t = Date.parse(firstAt);
  if (Number.isNaN(t)) return fallback;
  const age = Math.max(0, now - t);
  return candidates.find((r) => RANGE_MS[r] >= age) ?? candidates[candidates.length - 1];
}

/** The environment a page reads when the URL names none: `production` when listed, else the first, else all (""). */
export function defaultEnv(environments: readonly string[]): string {
  if (environments.includes(PREFERRED_ENV)) return PREFERRED_ENV;
  return environments[0] ?? "";
}

/** Whether the URL carries a range / an environment of its own. */
export function hasRange(params: SearchParams): boolean {
  return (first(params.range) ?? "").trim() !== "";
}
export function hasEnv(params: SearchParams): boolean {
  return (first(params.env) ?? "").trim() !== "";
}

/** The URL `env` for a page state's env: the name, or {@link ENV_ALL} for "" (all environments). */
export function envParam(env: string): string {
  return env || ENV_ALL;
}

/**
 * `params` with the scope defaults filled in, ready for the page's own parser: `range` from
 * {@link chooseRange} when missing (`firstAt` is only read then), `env` from {@link defaultEnv} when
 * missing, and `env=all` turned into "" (all environments). `envExplicit` says whether the URL
 * named the environment (a choice to remember) or the default was used (one to restore over).
 */
export async function withScopeDefaults(
  params: SearchParams,
  opts: {
    /** The project's environments; omitted on a page without an environment filter (env untouched). */
    environments?: readonly string[];
    /** When the project's first data arrived; called only when the URL has no range. */
    firstAt?: () => Promise<string | null | undefined>;
    ranges: readonly QueryRange[];
    fallbackRange: QueryRange;
    now?: number;
  },
): Promise<{ params: SearchParams; envExplicit: boolean }> {
  const out: SearchParams = { ...params };
  if (opts.firstAt && !hasRange(params)) {
    let at: string | null | undefined = null;
    try {
      at = await opts.firstAt();
    } catch {
      at = null;
    }
    out.range = chooseRange(at, opts.now ?? Date.now(), opts.ranges, opts.fallbackRange);
  }
  const envExplicit = hasEnv(params);
  if (!opts.environments) return { params: out, envExplicit };
  if (!envExplicit) out.env = defaultEnv(opts.environments);
  else if ((first(params.env) ?? "").trim() === ENV_ALL) out.env = "";
  return { params: out, envExplicit };
}

// The remembered environment, per project, in this browser. Storage can be missing or throw
// (private windows, blocked site data); every access is guarded and a failure means "nothing kept".

type Store = Pick<Storage, "getItem" | "setItem">;

/** The localStorage key of a project's last environment. */
export function envStorageKey(project: string): string {
  return `apilens:env:${project}`;
}

function browserStore(): Store | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The environment last chosen for `project` (a name or {@link ENV_ALL}), or null. */
export function rememberedEnv(project: string, store: Store | null = browserStore()): string | null {
  try {
    const v = store?.getItem(envStorageKey(project));
    return v && v.trim() ? v : null;
  } catch {
    return null;
  }
}

/** Keeps `env` (a name or {@link ENV_ALL}) as the last choice for `project`. */
export function rememberEnv(project: string, env: string, store: Store | null = browserStore()): void {
  try {
    if (env.trim()) store?.setItem(envStorageKey(project), env);
  } catch {
    // Nothing kept: the default applies next time.
  }
}

/**
 * The environment to switch to when the page used the default: the remembered one, when it is
 * {@link ENV_ALL} or still one of the project's and differs from what the page shows; else null.
 */
export function envToRestore(remembered: string | null, shown: string, environments: readonly string[]): string | null {
  if (!remembered) return null;
  if (remembered !== ENV_ALL && !environments.includes(remembered)) return null;
  return remembered === envParam(shown) ? null : remembered;
}

/** `href` (path and query) with `env` set to `value`. */
export function hrefWithEnv(href: string, value: string): string {
  const [path, query = ""] = href.split("?", 2);
  const p = new URLSearchParams(query);
  p.set("env", value);
  return `${path}?${p.toString()}`;
}
