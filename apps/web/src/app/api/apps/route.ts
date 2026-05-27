import { NextResponse } from "next/server";
import { withAuth, apiResult } from "@/lib/proxy";
import { apiClient } from "@/lib/api-client";
import type { FrameworkId } from "@/types/app";

const VALID_FRAMEWORKS: FrameworkId[] = ["fastapi", "flask", "django", "starlette", "express"];

export const GET = () =>
  withAuth(async () => apiResult(await apiClient.getApps(), "apps"));

export const POST = (request: Request) =>
  withAuth(async () => {
    const body = await request.json();
    const name = body.name?.trim();
    const framework = String(body.framework || "fastapi").toLowerCase() as FrameworkId;
    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }
    if (!VALID_FRAMEWORKS.includes(framework)) {
      return NextResponse.json({ error: "Invalid framework" }, { status: 400 });
    }
    return apiResult(
      await apiClient.createApp({
        name,
        description: body.description || "",
        framework,
      }),
    );
  });
