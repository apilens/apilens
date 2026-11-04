// POST /api/auth/handoff {code, remember?, next?}: redeems the one-time code an OAuth/SSO callback
// hands the UI. Sets the session cookie and answers `{ok: true, next}`, or
// `{ok: false, code: "2fa_required"}`.
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

export async function POST(req: NextRequest) {
  try {
    const body = await readJson(req);
    const code = requiredString(body, "code", 2048);
    const remember = optionalBoolean(body, "remember");
    const result = await identity().handoff({ code }, callContext(req));
    return await finishSignIn(result, remember, requestedNext(body));
  } catch (err) {
    return fromError(err);
  }
}
