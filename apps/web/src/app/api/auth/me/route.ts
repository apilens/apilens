import { NextResponse } from "next/server";
import { withAuth, apiResult } from "@/lib/proxy";
import { apiClient } from "@/lib/api-client";
import { getSession, clearSession } from "@/lib/session";

export const GET = () =>
  withAuth(async () => {
    const session = await getSession();
    if (session) {
      const validation = await apiClient.validateSession(session.refreshToken);
      if (validation.data && !validation.data.valid) {
        await clearSession();
        return NextResponse.json({ error: "Session revoked" }, { status: 401 });
      }
    }

    return apiResult(await apiClient.getCurrentUser(), "user");
  });
