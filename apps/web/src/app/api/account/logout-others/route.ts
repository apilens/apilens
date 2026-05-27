import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { apiClient } from "@/lib/api-client";

export async function POST() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const result = await apiClient.logoutOthers();
  if (result.error || !result.data) {
    return NextResponse.json(
      { error: result.error || "Failed to sign out other devices" },
      { status: result.status },
    );
  }

  // Current session intentionally NOT cleared — that's the whole point.
  return NextResponse.json({ message: result.data.message });
}
