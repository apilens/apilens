// GET /auth/callback?code=…: identity redirects here after a Google or GitHub sign-in (#317) with a
// one-time handoff code. The code is redeemed on the server, the session cookie is sealed, and the
// browser goes on to `next` (onboarding for a new user), the two-factor step, or, on `?error=` or a
// dead code, `/sign-in?error=<code>`. Public in the auth gate (`/auth`). See `lib/oauth.ts`.
import type { NextRequest } from "next/server";
import { exchangeHandoff } from "@/lib/oauth";

export async function GET(req: NextRequest) {
  return exchangeHandoff(req);
}
