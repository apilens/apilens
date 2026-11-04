// POST /api/auth/sso/lookup {email, next?}: does the email's domain sign in through an
// organization's SSO (#323)? Answers `{ok: true, sso: false}` or
// `{ok: true, sso: true, enforced, org_name, start_url}`, where `start_url` is identity's SSO
// start already carrying `next`, `remember` and `login_hint`. POST so the address stays out of
// access logs.
import { type NextRequest, NextResponse } from "next/server";
import { callContext, email, fromError, readJson, requestedNext } from "@/lib/auth-routes";
import { identity } from "@/lib/identity";
import { ssoStartHref } from "@/lib/sso";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(req: NextRequest) {
  try {
    const body = await readJson(req);
    const address = email(body);
    const next = requestedNext(body);
    const found = await identity().ssoLookup(address, callContext(req));
    const startUrl = found.sso ? ssoStartHref(found.start_url, { email: address, next }) : null;
    if (!startUrl) return NextResponse.json({ ok: true, sso: false, enforced: false }, { headers: NO_STORE });
    return NextResponse.json(
      { ok: true, sso: true, enforced: found.enforced === true, org_name: found.org_name ?? null, start_url: startUrl },
      { headers: NO_STORE },
    );
  } catch (err) {
    return fromError(err);
  }
}
