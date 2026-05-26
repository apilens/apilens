import { NextResponse } from "next/server";
import { getSession, clearSession } from "@/lib/session";
import { apiClient } from "@/lib/api-client";

const COOKIE_NAME = "apilens_session";

export async function POST() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  try {
    await apiClient.logoutAll();
  } catch {
    // Continue — still clear local session even if Django call fails
  }

  // Clear the current device's session cookie so the user is immediately
  // logged out here too, not just on other devices.
  const res = NextResponse.json({ message: "All sessions have been revoked" });
  res.cookies.set(COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production" && !process.env.DJANGO_API_URL?.includes("localhost"),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}
