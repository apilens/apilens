import { withAuth, apiResult } from "@/lib/proxy";
import { apiClient } from "@/lib/api-client";
import { NextResponse } from "next/server";

export const GET = (
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) =>
  withAuth(async () => {
    const url = new URL(request.url);
    const consumer = url.searchParams.get("consumer") || "";
    const environment = url.searchParams.get("environment") || undefined;
    const since = url.searchParams.get("since") || undefined;
    const until = url.searchParams.get("until") || undefined;
    const limit = Number(url.searchParams.get("limit") || "100");
    const slug = (await params).slug;

    if (!consumer.trim()) {
      return NextResponse.json({ error: "consumer is required" }, { status: 400 });
    }

    return apiResult(
      await apiClient.getConsumerRequestStats(slug, {
        consumer,
        environment,
        since,
        until,
        limit,
      }),
    );
  });
