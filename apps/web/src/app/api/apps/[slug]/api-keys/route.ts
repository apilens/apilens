import { NextResponse } from "next/server";
import { withAuth, apiResult } from "@/lib/proxy";
import { apiClient } from "@/lib/api-client";

export const GET = (
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) =>
  withAuth(async () => apiResult(await apiClient.getAppApiKeys((await params).slug), "keys"));

export const POST = (
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) =>
  withAuth(async () => {
    const body = await request.json();
    const name = body.name?.trim();
    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }
    return apiResult(await apiClient.createAppApiKey((await params).slug, name));
  });

