import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { apiClient } from "@/lib/api-client";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => ({}));
  const { code, password } = body as { code?: string; password?: string };
  if (!code) {
    return NextResponse.json({ error: "Code is required" }, { status: 400 });
  }
  const result = await apiClient.twoFactorVerify({
    code,
    ...(password ? { password } : {}),
  });
  if (result.error || !result.data) {
    return NextResponse.json(
      { error: result.error || "Verification failed" },
      { status: result.status },
    );
  }
  return NextResponse.json(result.data);
}
