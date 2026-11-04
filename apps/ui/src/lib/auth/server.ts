// Per-request auth loaders for Server Components (#308). Both are wrapped in React `cache()`, so
// a page, its `generateMetadata` and anything else rendered in the same request share one
// session read and one `GET /users/me/context` call.
import "server-only";
import { cache } from "react";
import { identity, type UserContext } from "../identity";
import { type ServerSession, componentSession, isSessionExpired, redirectToRefresh } from "../server-session";

/** The read-only session of this request (see `componentSession`). */
export const getSession = cache((): Promise<ServerSession> => componentSession());

/**
 * The signed-in user's orgs, projects and roles. `next` is the page's own path: when the
 * session is missing or its access token is no longer usable here, the browser goes through the
 * refresh route and comes back to it (or lands on sign-in when the session is over).
 */
export const getContext = cache(async (next: string): Promise<UserContext> => {
  const session = await getSession();
  if (!session.payload) redirectToRefresh(next);
  try {
    return await session.call((o) => identity().context(o));
  } catch (err) {
    if (isSessionExpired(err)) redirectToRefresh(next);
    throw err;
  }
});
