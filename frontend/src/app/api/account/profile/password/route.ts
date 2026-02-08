import { NextRequest, NextResponse } from "next/server";
import { withAuth, apiResult } from "@/lib/proxy";
import { apiClient } from "@/lib/api-client";

export const POST = (request: NextRequest) =>
  withAuth(async () => {
    const { new_password, confirm_password, current_password } = await request.json();
    if (!new_password || !confirm_password) {
      return NextResponse.json({ error: "Password fields are required" }, { status: 400 });
    }
    return apiResult(
      await apiClient.setPassword({
        new_password,
        confirm_password,
        ...(current_password ? { current_password } : {}),
      }),
    );
  });
