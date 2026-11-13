// Renamed project slugs (#753 D9, #821): a URL under a slug the project no longer has redirects
// to the same page under its current slug. The proxy passes the request's path to Server
// Components in PATH_HEADER, since a layout is not told the rest of the URL. Pure; no server imports.

/** Request header the proxy sets to the request's path and query (it drops any client copy). */
export const PATH_HEADER = "x-apilens-path";

/**
 * `path` (from PATH_HEADER) with its first segment `from` replaced by `to`: `/old/settings?x=1`
 * → `/new/settings?x=1`. Anything that is not a path under `/from` answers `/to`, so the target
 * never leaves the app.
 */
export function renamedPath(path: string | null | undefined, from: string, to: string): string {
  const prefix = `/${from}`;
  if (path && path.startsWith(prefix)) {
    const rest = path.slice(prefix.length);
    if (rest === "" || rest.startsWith("?")) return `/${to}${rest}`;
    if (rest.startsWith("/") && !rest.startsWith("//") && !rest.includes("\\")) return `/${to}${rest}`;
  }
  return `/${to}`;
}
