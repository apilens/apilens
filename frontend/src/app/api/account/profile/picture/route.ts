import { NextRequest, NextResponse } from "next/server";
import { withAuth, apiResult } from "@/lib/proxy";
import { apiClient } from "@/lib/api-client";

export const POST = (request: NextRequest) =>
  withAuth(async () => {
    const formData = await request.formData();
    const file = formData.get("file") as Blob | null;
    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }
    return apiResult(await apiClient.uploadPicture(file));
  });

export const DELETE = () =>
  withAuth(async () => apiResult(await apiClient.removePicture()));
