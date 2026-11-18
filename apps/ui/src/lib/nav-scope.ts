// Scope travels across navigation (#992, decision D4 of #963): the sidebar's page links keep the
// `range` and `env` of the page being read, so moving from Traffic to Errors keeps the last 7 days
// in production. Pure; safe in Client Components.
import { ENV_ALL } from "./scope-defaults";
import { projectHref } from "./routes";

/** The search params that travel with the sidebar's links, in this order. */
export const SCOPE_PARAMS = ["range", "env"] as const;

/** The longest value a travelling param may have (a shared link could carry anything). */
const MAX_VALUE = 64;

type Readable = Pick<URLSearchParams, "get"> | null | undefined;

/** The pages that read `env=all` as "All environments" (#993); elsewhere it would filter on an environment named "all". */
export const ENV_ALL_VIEWS: ReadonlySet<string> = new Set(["traffic", "performance", "errors"]);

/**
 * `href` with the scope of `current` appended: `range` and `env` when they are set (and short), any
 * other param of the current page left behind. `href` may already carry a query string; a param it
 * sets wins. `env=all` (#993) travels only with `keepEnvAll`, to a page that reads it.
 */
export function withScope(href: string, current: Readable, opts: { keepEnvAll?: boolean } = {}): string {
  if (!current) return href;
  const [path, query = ""] = href.split("?", 2);
  const p = new URLSearchParams(query);
  for (const key of SCOPE_PARAMS) {
    const v = (current.get(key) ?? "").trim();
    if (key === "env" && v === ENV_ALL && !opts.keepEnvAll) continue;
    if (v && v.length <= MAX_VALUE && !p.has(key)) p.set(key, v);
  }
  const s = p.toString();
  return s ? `${path}?${s}` : path;
}

/** A sidebar link to one of the project's pages (`/project/<project>/<view>`), keeping the scope. */
export function sidebarHref(project: string, view: string, current: Readable): string {
  return withScope(projectHref(project, view), current, { keepEnvAll: ENV_ALL_VIEWS.has(view) });
}
