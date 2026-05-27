import { withAuth, apiResult } from "@/lib/proxy";
import { apiClient } from "@/lib/api-client";

export const DELETE = (
  _request: Request,
  { params }: { params: Promise<{ slug: string; app_slug: string; keyId: string }> },
) =>
  withAuth(async () => {
    const { slug, app_slug, keyId } = await params;
    return apiResult(await apiClient.revokeProjectAppApiKey(slug, app_slug, keyId));
  });
