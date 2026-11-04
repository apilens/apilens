// POST /api/auth/recovery/cancel {token}: cancels a pending recovery request from the link in the
// alert email (#321). Answers `{ok: true, next}`; cancelling twice is fine.
import type { NextRequest } from "next/server";
import { SIGN_IN_PATH } from "@/lib/auth-gate";
import { callContext, fromError, readJson, requiredString, success } from "@/lib/auth-routes";
import { identity } from "@/lib/identity";
import { MAX_RECOVERY_TOKEN_LENGTH } from "@/lib/recovery";

export async function POST(req: NextRequest) {
  try {
    const body = await readJson(req);
    const token = requiredString(body, "token", MAX_RECOVERY_TOKEN_LENGTH);
    await identity().recoveryCancel({ token }, callContext(req));
    return success(SIGN_IN_PATH);
  } catch (err) {
    return fromError(err);
  }
}
