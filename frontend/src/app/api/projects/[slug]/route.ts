import { NextResponse } from "next/server";
import { withAuth, apiResult } from "@/lib/proxy";
import { apiClient } from "@/lib/api-client";

export const GET = (
  _request: Request,
  { params }: { params: Promise<{ slug: string }> }
) =>
  withAuth(async () => {
    const { slug } = await params;
    return apiResult(await apiClient.getProject(slug));
  });

export const PATCH = (
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
) =>
  withAuth(async () => {
    const { slug } = await params;
    const body = await request.json();
    return apiResult(
      await apiClient.updateProject(slug, {
        name: body.name,
        description: body.description,
      })
    );
  });

export const DELETE = (
  _request: Request,
  { params }: { params: Promise<{ slug: string }> }
) =>
  withAuth(async () => {
    const { slug } = await params;
    return apiResult(await apiClient.deleteProject(slug));
  });
