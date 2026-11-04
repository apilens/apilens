// POST /api/auth/recovery/request {email}: starts lost-device recovery (#321). Identity always
// answers `{sent: true}`, so this answers `{ok: true, next}` whether or not the account exists.
import type { NextRequest } from "next/server";
import { callContext, email, fromError, readJson, success } from "@/lib/auth-routes";
import { identity } from "@/lib/identity";
import { RECOVERY_PATH } from "@/lib/recovery-client";

export async function POST(req: NextRequest) {
  try {
    const body = await readJson(req);
    await identity().recoveryRequest({ email: email(body) }, callContext(req));
    return success(RECOVERY_PATH);
  } catch (err) {
    return fromError(err);
  }
}
