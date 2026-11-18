// Renamed project slugs (#753 D9, #821): a URL under a slug the project no longer has redirects
// to the same page under its current slug. The proxy passes the request's path to Server
// Components in PATH_HEADER, since a layout is not told the rest of the URL. Pure; no server imports.
import { projectHref } from "./routes";

/** Request header the proxy sets to the request's path and query (it drops any client copy). */
export const PATH_HEADER = "x-apilens-path";

/**
 * `path` (from PATH_HEADER) with the project `from` replaced by `to`: `/project/old/settings?x=1`
 * → `/project/new/settings?x=1`. Anything that is not a path under `/project/<from>` answers
 * `/project/<to>`, so the target never leaves the app.
 */
export function renamedPath(path: string | null | undefined, from: string, to: string): string {
  const prefix = projectHref(from);
  const target = projectHref(to);
  if (path && path.startsWith(prefix)) {
    const rest = path.slice(prefix.length);
    if (rest === "" || rest.startsWith("?")) return `${target}${rest}`;
    if (rest.startsWith("/") && !rest.startsWith("//") && !rest.includes("\\")) return `${target}${rest}`;
  }
  return target;
}
