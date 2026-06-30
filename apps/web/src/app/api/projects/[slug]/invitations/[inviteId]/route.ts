import { withAuth, apiResult } from "@/lib/proxy";
import { apiClient } from "@/lib/api-client";

export const DELETE = (
  _request: Request,
  { params }: { params: Promise<{ slug: string; inviteId: string }> },
) =>
  withAuth(async () => {
    const { slug, inviteId } = await params;
    return apiResult(await apiClient.revokeProjectInvitation(slug, inviteId));
  });
