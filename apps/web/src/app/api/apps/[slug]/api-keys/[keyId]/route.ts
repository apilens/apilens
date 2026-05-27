import { withAuth, apiResult } from "@/lib/proxy";
import { apiClient } from "@/lib/api-client";

export const DELETE = (
  _request: Request,
  { params }: { params: Promise<{ slug: string; keyId: string }> },
) =>
  withAuth(async () => {
    const { slug, keyId } = await params;
    return apiResult(await apiClient.revokeAppApiKey(slug, keyId));
  });

