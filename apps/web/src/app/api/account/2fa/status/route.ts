import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { apiClient } from "@/lib/api-client";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await apiClient.twoFactorStatus();
  if (result.error || !result.data) {
    return NextResponse.json(
      { error: result.error || "Failed to fetch 2FA status" },
      { status: result.status },
    );
  }
  return NextResponse.json(result.data);
}
