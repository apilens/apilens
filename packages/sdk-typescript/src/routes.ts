/**
 * Endpoint route-template resolution (port of the Python SDK `_routes.py`).
 *
 * Raw request paths (`/product/123`, `/product/324`) must collapse to one
 * logical endpoint (`/product/{id}`) or every id becomes its own endpoint.
 * The framework's matched route is used first (Express: `req.baseUrl` +
 * `req.route.path`, with `:name` params spelled `{name}`). When no route
 * matched, id-looking segments are parametrized by a conservative heuristic.
 *
 * `parametrizePaths: false` on the middleware, or
 * `APILENS_PARAMETRIZE_PATHS=false` (env wins over code), turns the heuristic
 * off; framework templates are always used.
 */

import { processEnv } from "./runtime.js";

/** Env kill-switch for the heuristic fallback. */
export const ENV_PARAMETRIZE_PATHS = "APILENS_PARAMETRIZE_PATHS";

const INT_RE = /^\d+$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// Crockford base32, 26 chars (ULID / KSUID-like).
const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}$/;
// Long pure hex: Mongo ObjectId (24), SHA-1 (40), SHA-256 (64), etc.
const HEX_RE = /^[0-9a-fA-F]{24,}$/;
// Long mixed token that CONTAINS a digit (nano ids, encoded ids). Requiring a
// digit keeps ordinary words (`settings`, `openapi`) intact.
const MIXED_ID_RE = /^(?=[A-Za-z0-9._~-]*\d)[A-Za-z0-9._~-]{16,}$/;

/** Placeholder for an id-looking path segment, else `undefined`. */
function segmentPlaceholder(segment: string): string | undefined {
  if (INT_RE.test(segment)) {
    return "{id}";
  }
  if (UUID_RE.test(segment)) {
    return "{uuid}";
  }
  if (ULID_RE.test(segment)) {
    return "{id}";
  }
  if (HEX_RE.test(segment)) {
    return "{hash}";
  }
  if (MIXED_ID_RE.test(segment)) {
    return "{id}";
  }
  return undefined;
}

/**
 * Heuristically replace id-looking segments of `path` (no query string) with
 * placeholders: integer and ULID → `{id}`, UUID → `{uuid}`, hex ≥ 24 chars →
 * `{hash}`, mixed alphanumeric with a digit ≥ 16 chars → `{id}`.
 */
export function parametrizePath(path: string): string {
  if (!path || path === "/") {
    return path || "/";
  }
  return path
    .split("/")
    .map((segment) => (segment ? segmentPlaceholder(segment) ?? segment : segment))
    .join("/");
}

/** False when `APILENS_PARAMETRIZE_PATHS` is `0`/`false`/`no`/`off`. */
export function parametrizeEnabled(env: Record<string, string | undefined> = processEnv()): boolean {
  const raw = env[ENV_PARAMETRIZE_PATHS];
  if (raw === undefined) {
    return true;
  }
  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

/**
 * Express route path → `{name}` template: `/users/:id` → `/users/{id}`,
 * `/files/*path` → `/files/{path}`, `/a{/:b}` → `/a/{b}`, and Express 4
 * `:id(\\d+)` / `:id?` lose their regex and modifier. Undefined for a
 * non-string path (RegExp or array routes).
 */
export function expressPathToTemplate(routePath: unknown): string | undefined {
  if (typeof routePath !== "string") {
    return undefined;
  }
  const params: string[] = [];
  const marked = routePath
    // Express 4 / path-to-regexp 0.x: `:id(\\d+)?`, `:id*`, `:id+`.
    .replace(/(?<!\\)[:*]([A-Za-z_$][\w$]*)(?:\((?:\\.|[^()\\])*\))?[?*+]?/g, (_m, name: string) => {
      params.push(name);
      return `\u0000${params.length - 1}\u0000`;
    })
    // Express 5 / path-to-regexp 8: optional groups `{...}` and escapes.
    .replace(/(?<!\\)[{}]/g, "")
    .replace(/\\(.)/g, "$1");
  return marked.replace(/\u0000(\d+)\u0000/g, (_m, index: string) => `{${params[Number(index)]}}`);
}

function joinPaths(base: string, path: string): string {
  const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
  if (!path || path === "/") {
    return trimmed || "/";
  }
  return `${trimmed}${path.startsWith("/") ? path : `/${path}`}`;
}

function segmentCount(path: string): number {
  return path.split("/").filter(Boolean).length;
}

type ExpressLikeRequest = {
  baseUrl?: unknown;
  route?: { path?: unknown } | undefined;
};

/**
 * Template of the route that matched an Express request, or undefined when
 * none did (404, static files, RegExp routes). Mounted routers are handled
 * via `req.baseUrl`; its id-looking segments (a mount such as
 * `/users/:userId`, which Express reports already filled in) are
 * parametrized when `parametrize` is true. `rawPath` (no query) guards
 * against a stale `req.route` from an inner router whose response was sent
 * after control left it: a template whose segment count disagrees with the
 * raw path (and has no wildcard/optional part) is discarded.
 */
export function expressRouteTemplate(
  req: ExpressLikeRequest,
  rawPath: string,
  parametrize = true,
): string | undefined {
  const routePath = req.route?.path;
  const template = expressPathToTemplate(routePath);
  if (template === undefined) {
    return undefined;
  }
  const baseUrl = typeof req.baseUrl === "string" ? req.baseUrl : "";
  const base = parametrize ? parametrizePath(baseUrl) : baseUrl;
  const full = joinPaths(base, template);
  const variable = /[*?{(+]/.test(String(routePath));
  if (!variable && segmentCount(full) !== segmentCount(rawPath)) {
    return undefined;
  }
  return full;
}

/**
 * Endpoint (grouping) path: the framework template, else the heuristic (when
 * enabled in code and not disabled by `APILENS_PARAMETRIZE_PATHS`), else the
 * raw path. `raw_path` is always sent separately.
 */
export function resolveEndpointPath(
  template: string | undefined | null,
  rawPath: string,
  parametrize = true,
): string {
  if (template) {
    return template;
  }
  if (parametrize && parametrizeEnabled()) {
    return parametrizePath(rawPath);
  }
  return rawPath;
}
