import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { apiClient } from "@/lib/api-client";

export async function POST() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Going through apiClient so an expired access token is refreshed
  // transparently — avoids the "Failed to regenerate backup codes" surface
  // when the user comes back to a stale tab.
  const result = await apiClient.twoFactorRegenerateBackupCodes();
  if (result.error || !result.data) {
    return NextResponse.json(
      { error: result.error || "Failed to regenerate backup codes" },
      { status: result.status },
    );
  }
  return NextResponse.json(result.data);
}
