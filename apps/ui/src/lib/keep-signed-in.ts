// "Keep me signed in" travels with every sign-in method. Start links are built on the server with
// remember=true; the page rewrites them with the box's state when one is followed. Client-safe.

/** Query parameter `/verify` reads its checkbox from. */
export const REMEMBER_PARAM = "remember";

/** `href` with `remember` set to the box's state; an unparseable href is returned unchanged. */
export function withRemember(href: string, remember: boolean): string {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return href;
  }
  url.searchParams.set(REMEMBER_PARAM, String(remember));
  return url.href;
}

/** The box's state from `?remember=`: unticked only for an explicit 0 or false. */
export function rememberFromParam(value: string | null | undefined): boolean {
  return value !== "0" && value !== "false";
}

/** A same-origin path (like `/verify?…`) marked with an unticked box; a ticked box changes nothing. */
export function pathWithRemember(path: string, remember: boolean): string {
  if (remember) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${REMEMBER_PARAM}=0`;
}
