import { withAuth, apiResult } from "@/lib/proxy";
import { apiClient } from "@/lib/api-client";

export const GET = (
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) =>
  withAuth(async () => {
    const url = new URL(request.url);
    const method = url.searchParams.get("method") || "GET";
    const path = url.searchParams.get("path") || "/";
    const environment = url.searchParams.get("environment") || undefined;
    const since = url.searchParams.get("since") || undefined;
    const until = url.searchParams.get("until") || undefined;
    const limit = Number(url.searchParams.get("limit") || "20");
    const slug = (await params).slug;

    return apiResult(await apiClient.getEndpointPayloads(slug, { method, path, environment, since, until, limit }));
  });
