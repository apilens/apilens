import { NextRequest, NextResponse } from "next/server";
import { getSession, setSession } from "@/lib/session";
import { apiClient } from "@/lib/api-client";

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const { new_password, confirm_password, current_password } = await request.json();
  if (!new_password || !confirm_password) {
    return NextResponse.json({ error: "Password fields are required" }, { status: 400 });
  }

  const result = await apiClient.setPassword({
    new_password,
    confirm_password,
    ...(current_password ? { current_password } : {}),
  });

  if (result.error || !result.data) {
    return NextResponse.json(
      { error: result.error || "Failed to update password" },
      { status: result.status },
    );
  }

  // Backend revoked all sessions and issued fresh tokens for this device.
  // Rewrite the cookie so this device stays logged in; other devices are out.
  await setSession(
    {
      accessToken: result.data.access_token,
      refreshToken: result.data.refresh_token,
      user: session.user,
    },
    true,
  );

  return NextResponse.json({ message: result.data.message });
}
