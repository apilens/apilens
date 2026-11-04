// POST /api/auth/email/start {email, intent?, next?, remember?}: emails a sign-in code and link.
// Answers `{ok: true, next, retry_after}` where `next` is the "check your inbox" page. An address
// whose organization enforces SSO gets 403 `{ok: false, code: "sso_required", start_url}` (#323).
import { type NextRequest, NextResponse } from "next/server";
import {
  type AuthRouteBody,
  callContext,
  email,
  fromError,
  optionalBoolean,
  optionalEnum,
  readJson,
  requestedNext,
  success,
} from "@/lib/auth-routes";
import { type EmailIntent, identity, isApiError } from "@/lib/identity";
import { ssoStartHref } from "@/lib/sso";

const INTENTS: readonly EmailIntent[] = ["signin", "signup"];

export async function POST(req: NextRequest) {
  let address: string | undefined;
  let next: string | undefined;
  try {
    const body = await readJson(req);
    address = email(body);
    const intent = optionalEnum(body, "intent", INTENTS, "signin");
    next = requestedNext(body);
    const remember = optionalBoolean(body, "remember");
    const sent = await identity().emailStart({ email: address, intent, next, remember }, callContext(req));
    const verify = new URLSearchParams({ flow: intent, email: address });
    if (next) verify.set("next", next);
    return success(`/verify?${verify}`, { retry_after: sent.retry_after });
  } catch (err) {
    if (isApiError(err) && err.code === "sso_required") {
      const startUrl = ssoStartHref(err.problem?.start_url, { email: address, next });
      const body: AuthRouteBody = { ok: false, code: err.code, ...(startUrl ? { start_url: startUrl } : {}) };
      return NextResponse.json(body, { status: err.status, headers: { "Cache-Control": "no-store" } });
    }
    return fromError(err);
  }
}
