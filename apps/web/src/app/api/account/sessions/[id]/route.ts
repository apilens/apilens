import { withAuth, apiResult } from "@/lib/proxy";
import { apiClient } from "@/lib/api-client";

export const DELETE = (
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) =>
  withAuth(async () => apiResult(await apiClient.revokeSession((await params).id)));
