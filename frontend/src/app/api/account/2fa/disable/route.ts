import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { apiClient } from "@/lib/api-client";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => ({}));
  const { password, code, backup_code } = body as {
    password?: string;
    code?: string;
    backup_code?: string;
  };

  const result = await apiClient.twoFactorDisable({
    ...(password ? { password } : {}),
    ...(code ? { code } : {}),
    ...(backup_code ? { backup_code } : {}),
  });
  if (result.error || !result.data) {
    return NextResponse.json(
      { error: result.error || "Failed to disable 2FA" },
      { status: result.status },
    );
  }
  return NextResponse.json(result.data);
}
