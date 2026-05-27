import { NextRequest, NextResponse } from "next/server";
import { withAuth, apiResult } from "@/lib/proxy";
import { apiClient } from "@/lib/api-client";

export const POST = (
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) =>
  withAuth(async () => {
    const formData = await request.formData();
    const file = formData.get("file") as Blob | null;
    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }
    return apiResult(await apiClient.uploadAppIcon((await params).slug, file));
  });

export const DELETE = (
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) =>
  withAuth(async () => apiResult(await apiClient.removeAppIcon((await params).slug)));
