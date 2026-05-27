import { withAuth, apiResult } from "@/lib/proxy";
import { apiClient } from "@/lib/api-client";
import { NextResponse } from "next/server";

export const GET = (
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) =>
  withAuth(async () => {
    const url = new URL(request.url);
    const endpointId = url.searchParams.get("endpoint_id") || "";
    if (!endpointId.trim()) {
      return NextResponse.json({ error: "endpoint_id is required" }, { status: 400 });
    }
    const slug = (await params).slug;
    return apiResult(await apiClient.getEndpointMeta(slug, endpointId));
  });
