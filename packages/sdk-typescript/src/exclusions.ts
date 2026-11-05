/**
 * Request exclusions: skip capture entirely for health checks, probes and
 * static well-known files. Port of the Python SDK's exclusions module, with
 * the same built-in default lists (Apitally parity).
 *
 * An excluded request is never sent: no record, and the middleware does not
 * wrap the response or buffer any body for it.
 */

export const ENV_EXCLUDE_PATHS = "APILENS_EXCLUDE_PATHS";

/**
 * Built-in path patterns, matched case-insensitively against the request path
 * (query string ignored). Turned off with `defaultExclusions: false`.
 */
export const DEFAULT_EXCLUDED_PATHS: readonly string[] = Object.freeze([
  "/_?healthz?$",
  "/_?health[-_]?checks?$",
  "/_?heart[-_]?beats?$",
  "/ping$",
  "/ready$",
  "/live$",
  "/favicon(?:-[\\w-]+)?\\.(?:ico|png|svg)$",
  "/apple-touch-icon(?:-[\\w-]+)?\\.png$",
  "/robots\\.txt$",
  "/sitemap\\.xml$",
  "/manifest\\.json$",
  "/site\\.webmanifest$",
  "/service-worker\\.js$",
  "/sw\\.js$",
  "/\\.well-known/",
]);

/**
 * Built-in user-agent patterns (load balancer and orchestrator probes),
 * matched case-insensitively. Turned off with `defaultExclusions: false`.
 */
export const DEFAULT_EXCLUDED_USER_AGENTS: readonly string[] = Object.freeze([
  "health[-_ ]?check",
  "microsoft-azure-application-lb",
  "googlehc",
  "kube-probe",
]);

export type ExclusionPatterns = string | ReadonlyArray<string | RegExp> | null | undefined;

export type ExclusionOptions = {
  /** Extra path regexes; a string is split on commas. */
  excludePaths?: ExclusionPatterns;
  /** Extra user-agent regexes; a string is split on commas. */
  excludeUserAgents?: ExclusionPatterns;
  /** Apply the built-in default lists (default true). */
  defaultExclusions?: boolean;
  /** Add patterns from the `APILENS_EXCLUDE_PATHS` env var (default true). */
  includeEnv?: boolean;
};

/**
 * Normalize a pattern list given as a comma-separated string or an array.
 * Blank entries are dropped. A string is split on commas, so a regex that
 * needs a literal comma (`{1,3}`) must be passed as an array.
 */
export function splitPatterns(value: ExclusionPatterns): Array<string | RegExp> {
  if (value === null || value === undefined) {
    return [];
  }
  const items: ReadonlyArray<string | RegExp> =
    typeof value === "string" ? value.split(",") : value;
  const out: Array<string | RegExp> = [];
  for (const item of items) {
    if (item instanceof RegExp) {
      out.push(item);
      continue;
    }
    const trimmed = String(item).trim();
    if (trimmed) {
      out.push(trimmed);
    }
  }
  return out;
}

/**
 * Compile once, at middleware construction: an invalid regex throws a
 * `SyntaxError` there, never per request. Every pattern is case-insensitive;
 * the `g`/`y` flags are dropped so `test()` stays stateless.
 */
function compile(patterns: ReadonlyArray<string | RegExp>): RegExp[] {
  return patterns.map((p) => {
    if (typeof p === "string") {
      return new RegExp(p, "i");
    }
    const flags = p.flags.replace(/[gyi]/g, "");
    return new RegExp(p.source, `${flags}i`);
  });
}

function envExcludePaths(): Array<string | RegExp> {
  return splitPatterns(globalThis.process?.env?.[ENV_EXCLUDE_PATHS]);
}

function stripQuery(path: string | null | undefined): string {
  const value = path || "/";
  const q = value.indexOf("?");
  return q === -1 ? value : value.slice(0, q);
}

/**
 * Compiled exclusion rules. Built-in defaults come first, then user patterns,
 * then `APILENS_EXCLUDE_PATHS`. Patterns are searched (unanchored unless they
 * use `^` / `$`) against the actual request path without the query string,
 * so `^/health$` excludes `/health` but not `/healthz` or `/api/health`.
 */
export class RequestExcluder {
  readonly pathPatterns: readonly RegExp[];
  readonly userAgentPatterns: readonly RegExp[];

  constructor(options: ExclusionOptions = {}) {
    const useDefaults = options.defaultExclusions !== false;
    this.pathPatterns = compile([
      ...(useDefaults ? DEFAULT_EXCLUDED_PATHS : []),
      ...splitPatterns(options.excludePaths),
      ...(options.includeEnv === false ? [] : envExcludePaths()),
    ]);
    this.userAgentPatterns = compile([
      ...(useDefaults ? DEFAULT_EXCLUDED_USER_AGENTS : []),
      ...splitPatterns(options.excludeUserAgents),
    ]);
  }

  /** True when `path` (query string ignored) matches any path pattern. */
  matchesPath(path: string | null | undefined): boolean {
    if (this.pathPatterns.length === 0) {
      return false;
    }
    const value = stripQuery(path);
    return this.pathPatterns.some((p) => p.test(value));
  }

  /** True when a non-empty `userAgent` matches any user-agent pattern. */
  matchesUserAgent(userAgent: string | null | undefined): boolean {
    if (this.userAgentPatterns.length === 0 || !userAgent) {
      return false;
    }
    return this.userAgentPatterns.some((p) => p.test(userAgent));
  }

  /** True when the request should bypass capture entirely. */
  shouldExclude(path: string | null | undefined, userAgent?: string | null): boolean {
    return this.matchesPath(path) || this.matchesUserAgent(userAgent);
  }
}
