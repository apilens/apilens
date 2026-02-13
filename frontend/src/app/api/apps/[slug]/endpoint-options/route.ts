import { withAuth, apiResult } from "@/lib/proxy";
import { apiClient } from "@/lib/api-client";

export const GET = (
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) =>
  withAuth(async () => {
    const url = new URL(request.url);
    const environment = url.searchParams.get("environment") || undefined;
    const since = url.searchParams.get("since") || undefined;
    const until = url.searchParams.get("until") || undefined;
    const statusClasses = url.searchParams.get("status_classes") || undefined;
    const statusCodes = url.searchParams.get("status_codes") || undefined;
    const methods = url.searchParams.get("methods") || undefined;
    const q = url.searchParams.get("q") || undefined;
    const limit = url.searchParams.get("limit");
    const slug = (await params).slug;

    return apiResult(await apiClient.getEndpointOptions(slug, {
      environment,
      since,
      until,
      status_classes: statusClasses ? statusClasses.split(",").map((v) => v.trim()).filter(Boolean) as Array<"2xx" | "3xx" | "4xx" | "5xx"> : undefined,
      status_codes: statusCodes
        ? statusCodes
          .split(",")
          .map((v) => Number(v.trim()))
          .filter((n) => Number.isFinite(n))
        : undefined,
      methods: methods ? methods.split(",").map((v) => v.trim()).filter(Boolean) : undefined,
      q,
      limit: limit ? Number(limit) : undefined,
    }));
  });
