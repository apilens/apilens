// POST /api/auth/email/verify-link {token, remember?, next?}: signs in with the emailed magic link.
// Sets the session cookie and answers `{ok: true, next}`, or `{ok: false, code: "2fa_required"}`.
//
// GET /api/auth/email/verify-link?token=…&email=…&next=…: the same exchange as a browser
// navigation, for the `/verify?token=` landing page (#316): sets the cookie and redirects to
// `next`, or back to `/verify?link=expired|error` (see `lib/magic-link.ts`).
import type { NextRequest } from "next/server";
import {
  callContext,
  finishSignIn,
  fromError,
  optionalBoolean,
  readJson,
  requestedNext,
  requiredString,
} from "@/lib/auth-routes";
import { identity } from "@/lib/identity";
import { exchangeLink } from "@/lib/magic-link";

export async function POST(req: NextRequest) {
  try {
    const body = await readJson(req);
    const token = requiredString(body, "token", 2048);
    const remember = optionalBoolean(body, "remember");
    const result = await identity().emailVerifyLink({ token, remember }, callContext(req));
    return await finishSignIn(result, remember, requestedNext(body));
  } catch (err) {
    return fromError(err);
  }
}

export async function GET(req: NextRequest) {
  return exchangeLink(req);
}
