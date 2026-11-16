import type { Metadata } from "next";
import { headers } from "next/headers";
import { InviteLanding, InviteUnavailable } from "@/components/onboarding/invite";
import { getContext, getSession } from "@/lib/auth/server";
import { type InvitationPreview, contextFromHeaders, identity, isApiError } from "@/lib/identity";
import { expiresIn, invitePath, inviteProblem } from "@/lib/invitations";
import { ROLE_LABELS } from "@/lib/project-access";
import { roleLabel } from "@/lib/scope";

// The token is a credential: keep it out of the Referer of anything the page links to.
export const metadata: Metadata = { title: "Join your team", referrer: "no-referrer" };

type Params = { token: string };

/**
 * The invitation landing (#337). Public: the invitation is looked up on the server (identity's
 * rate-limited `GET /auth/invitations/{token}`) and shown before any sign-in. Signed-in visitors
 * accept it here; signed-out ones sign up (or in) and come back. An invitation sent from a
 * project's Access page names that project and the role it gives there (#809).
 */
export default async function Page({ params }: { params: Promise<Params> }) {
  const { token } = await params;

  let preview: InvitationPreview;
  try {
    preview = await identity().invitationLookup(token, contextFromHeaders(await headers()));
  } catch (err) {
    if (!isApiError(err)) throw err;
    return <InviteUnavailable problem={inviteProblem(err.code)} />;
  }

  const session = await getSession();
  const signedInAs = session.payload ? (await getContext(invitePath(token))).user.email : undefined;
  return (
    <InviteLanding
      token={token}
      signedInAs={signedInAs}
      invite={{
        orgName: preview.org.name,
        orgSlug: preview.org.slug,
        inviterName: preview.inviter_name ?? "",
        emailMasked: preview.email_masked,
        roleLabel: roleLabel(preview.role),
        expiresIn: expiresIn(preview.expires_at),
        projects: (preview.projects ?? []).map((p) => ({ name: p.name, roleLabel: ROLE_LABELS[p.role] ?? p.role })),
      }}
    />
  );
}
