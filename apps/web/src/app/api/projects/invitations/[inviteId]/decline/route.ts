import { withAuth, apiResult } from "@/lib/proxy";
import { apiClient } from "@/lib/api-client";

export const POST = (
  _request: Request,
  { params }: { params: Promise<{ inviteId: string }> },
) =>
  withAuth(async () => apiResult(await apiClient.declineInvitation((await params).inviteId)));
