import { withAuth, apiResult } from "@/lib/proxy";
import { apiClient } from "@/lib/api-client";

export const GET = (
  _request: Request,
  { params }: { params: Promise<{ slug: string; app_slug: string }> },
) =>
  withAuth(async () => {
    const { slug, app_slug } = await params;
    return apiResult(await apiClient.getProjectAppApiKeys(slug, app_slug));
  });

export const POST = (
  request: Request,
  { params }: { params: Promise<{ slug: string; app_slug: string }> },
) =>
  withAuth(async () => {
    const { slug, app_slug } = await params;
    const body = await request.json();
    return apiResult(await apiClient.createProjectAppApiKey(slug, app_slug, body));
  });
