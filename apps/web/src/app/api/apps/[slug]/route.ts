import { withAuth, apiResult } from "@/lib/proxy";
import { apiClient } from "@/lib/api-client";

export const GET = (
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) =>
  withAuth(async () => apiResult(await apiClient.getApp((await params).slug)));

export const PATCH = (
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) =>
  withAuth(async () => {
    const body = await request.json();
    return apiResult(await apiClient.updateApp((await params).slug, body));
  });

export const DELETE = (
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) =>
  withAuth(async () => apiResult(await apiClient.deleteApp((await params).slug)));

