// POST /api/auth/recovery/confirm {token}: once the cooling-off period has passed, turns 2FA off
// and signs in (#321). Seals the fresh session into the cookie and answers `{ok: true, next}`;
// before `ready_at` it answers `{ok: false, code: "recovery_not_ready", retry_after}`.
import type { NextRequest } from "next/server";
import { callContext, fromError, readJson, requiredString, signedIn } from "@/lib/auth-routes";
import { identity } from "@/lib/identity";
import { MAX_RECOVERY_TOKEN_LENGTH, RECOVERY_REMEMBER } from "@/lib/recovery";
import { RECOVERED_PATH } from "@/lib/recovery-client";

export async function POST(req: NextRequest) {
  try {
    const body = await readJson(req);
    const token = requiredString(body, "token", MAX_RECOVERY_TOKEN_LENGTH);
    const bundle = await identity().recoveryConfirm({ token }, callContext(req));
    return await signedIn(bundle, RECOVERY_REMEMBER, RECOVERED_PATH);
  } catch (err) {
    return fromError(err);
  }
}
