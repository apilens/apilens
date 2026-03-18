import { NextResponse } from "next/server";
import { withAuth, apiResult } from "@/lib/proxy";
import { apiClient } from "@/lib/api-client";

export const GET = (
  _request: Request,
  { params }: { params: Promise<{ slug: string }> }
) =>
  withAuth(async () => {
    const { slug } = await params;
    return apiResult(await apiClient.getProjectApps(slug), "apps");
  });

export const POST = (
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
) =>
  withAuth(async () => {
    const { slug } = await params;
    const body = await request.json();
    const name = body.name?.trim();
    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    // Call the backend API to create app within project
    const result = await apiClient.createProjectApp(slug, {
      name,
      description: body.description || "",
      framework: body.framework || "fastapi",
    });

    return apiResult(result);
  });
