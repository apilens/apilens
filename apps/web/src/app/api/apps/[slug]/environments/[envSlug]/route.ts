import { withAuth, apiResult } from "@/lib/proxy";
import { apiClient } from "@/lib/api-client";

export const DELETE = (
  _request: Request,
  { params }: { params: Promise<{ slug: string; envSlug: string }> },
) =>
  withAuth(async () => {
    const { slug, envSlug } = await params;
    return apiResult(await apiClient.deleteEnvironment(slug, envSlug));
  });
