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
    const paths = url.searchParams.get("paths") || undefined;
    const q = url.searchParams.get("q") || undefined;
    const sortBy = url.searchParams.get("sort_by") || undefined;
    const sortDir = url.searchParams.get("sort_dir") || undefined;
    const page = url.searchParams.get("page");
    const pageSize = url.searchParams.get("page_size");
    const endpoints = url.searchParams.getAll("endpoint");
    const slug = (await params).slug;
    return apiResult(await apiClient.getEndpointStats(slug, {
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
      paths: paths ? paths.split(",").map((v) => v.trim()).filter(Boolean) : undefined,
      endpoints: endpoints.length > 0 ? endpoints : undefined,
      q,
      sort_by: sortBy as "endpoint" | "total_requests" | "error_rate" | "avg_response_time_ms" | "p95_response_time_ms" | "data_transfer" | "last_seen_at" | undefined,
      sort_dir: sortDir === "asc" ? "asc" : sortDir === "desc" ? "desc" : undefined,
      page: page ? Number(page) : undefined,
      page_size: pageSize ? Number(pageSize) : undefined,
    }));
  });
