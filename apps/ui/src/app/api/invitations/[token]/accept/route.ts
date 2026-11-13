// POST /api/invitations/{token}/accept {}: accepts an invitation as the signed-in user (#337).
// Answers `{ok: true, next}`: the about step with the organization saved while onboarding is
// open (invited users skip the organization and project steps), else the organization's first
// project, or the project the invitation gives a role on (#809). Identity's codes pass through as `{ok: false, code}` (`invite_email_mismatch`,
// `invite_expired`, `invalid_token`).
import type { NextRequest } from "next/server";
import { fromError, readJson, success } from "@/lib/auth-routes";
import { contextFromHeaders, identity } from "@/lib/identity";
import { acceptInvitation, invitedProjectName } from "@/lib/invitations";
import { isSessionExpired, withSession } from "@/lib/server-session";

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return withSession(req, async (session) => {
    try {
      await readJson(req);
      // The public lookup names the invitation's projects; read it before accepting uses the token
      // up. Only where to land depends on it, so a failed lookup lands in the organization instead.
      const preview = await identity()
        .invitationLookup(token, contextFromHeaders(req.headers))
        .catch(() => null);
      const next = await acceptInvitation({
        projectName: invitedProjectName(preview),
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
