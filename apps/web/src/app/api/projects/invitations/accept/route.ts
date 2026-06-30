import { NextResponse } from "next/server";
import { withAuth, apiResult } from "@/lib/proxy";
import { apiClient } from "@/lib/api-client";

export const POST = (request: Request) =>
  withAuth(async () => {
    const body = await request.json();
    const token = body.token?.trim();
    if (!token) {
      return NextResponse.json({ error: "Token is required" }, { status: 400 });
    }
    return apiResult(await apiClient.acceptInvitation(token));
  });
