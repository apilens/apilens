// POST /api/auth/email/start {email, intent?, next?, remember?}: emails a sign-in code and link.
// Answers `{ok: true, next, retry_after}` where `next` is the "check your inbox" page.
import type { NextRequest } from "next/server";
import {
  callContext,
  email,
  fromError,
  optionalBoolean,
  optionalEnum,
  readJson,
  requestedNext,
  success,
} from "@/lib/auth-routes";
import { type EmailIntent, identity } from "@/lib/identity";

const INTENTS: readonly EmailIntent[] = ["signin", "signup"];

export async function POST(req: NextRequest) {
  try {
    const body = await readJson(req);
    const address = email(body);
    const intent = optionalEnum(body, "intent", INTENTS, "signin");
    const next = requestedNext(body);
    const remember = optionalBoolean(body, "remember");
    const sent = await identity().emailStart({ email: address, intent, next, remember }, callContext(req));
    const verify = new URLSearchParams({ flow: intent, email: address });
    if (next) verify.set("next", next);
    return success(`/verify?${verify}`, { retry_after: sent.retry_after });
  } catch (err) {
    return fromError(err);
  }
}
