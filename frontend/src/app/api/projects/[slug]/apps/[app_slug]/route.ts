import { NextResponse } from "next/server";
import { withAuth, apiResult } from "@/lib/proxy";
import { apiClient } from "@/lib/api-client";

export const GET = (
  _request: Request,
  { params }: { params: Promise<{ slug: string; app_slug: string }> }
) =>
  withAuth(async () => {
    const { slug, app_slug } = await params;
    return apiResult(await apiClient.getProjectApp(slug, app_slug));
  });

export const PATCH = (
  request: Request,
  { params }: { params: Promise<{ slug: string; app_slug: string }> }
) =>
  withAuth(async () => {
    const { slug, app_slug } = await params;
    const body = await request.json();
    const result = await apiClient.updateProjectApp(slug, app_slug, body);
    return apiResult(result);
  });

export const DELETE = (
  _request: Request,
  { params }: { params: Promise<{ slug: string; app_slug: string }> }
) =>
  withAuth(async () => {
    const { slug, app_slug } = await params;
    const result = await apiClient.deleteProjectApp(slug, app_slug);
    return apiResult(result);
  });
