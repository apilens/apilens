// POST /api/invitations/{token}/accept {}: accepts an invitation as the signed-in user (#337).
// Answers `{ok: true, next}`: the about step with the organization saved while onboarding is
// open (invited users skip the organization and project steps), else the organization's first
// project. Identity's codes pass through as `{ok: false, code}` (`invite_email_mismatch`,
// `invite_expired`, `invalid_token`).
import type { NextRequest } from "next/server";
import { fromError, readJson, success } from "@/lib/auth-routes";
import { identity } from "@/lib/identity";
import { acceptInvitation } from "@/lib/invitations";
import { isSessionExpired, withSession } from "@/lib/server-session";

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return withSession(req, async (session) => {
    try {
      await readJson(req);
      const next = await acceptInvitation({
        accept: () => session.call((o) => identity().invitationAccept(token, o)),
        context: () => session.call((o) => identity().context(o)),
        updateOnboarding: (patch) => session.call((o) => identity().updateOnboarding(patch, o)),
      });
      return success(next);
    } catch (err) {
      if (isSessionExpired(err)) throw err;
      return fromError(err);
    }
  });
}
