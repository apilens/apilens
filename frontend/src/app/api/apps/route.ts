import { NextResponse } from "next/server";
import { withAuth, apiResult } from "@/lib/proxy";
import { apiClient } from "@/lib/api-client";

export const GET = () =>
  withAuth(async () => apiResult(await apiClient.getApps(), "apps"));

export const POST = (request: Request) =>
  withAuth(async () => {
    const body = await request.json();
    const name = body.name?.trim();
    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }
    return apiResult(
      await apiClient.createApp({
        name,
        description: body.description || "",
        framework: body.framework || "fastapi",
      }),
    );
  });
