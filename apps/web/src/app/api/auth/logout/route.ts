import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";

const DJANGO_API_URL = process.env.DJANGO_API_URL || "http://localhost:8000/api/v1";
const COOKIE_NAME = "apilens_session";

export async function POST() {
  try {
    const session = await getSession();

    if (session) {
      // Revoke refresh token on Django side
      await fetch(`${DJANGO_API_URL}/auth/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: session.refreshToken }),
      }).catch(() => {}); // don't fail if Django is down
    }

    const res = NextResponse.json({ success: true });
    res.cookies.set(COOKIE_NAME, "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production" && !process.env.DJANGO_API_URL?.includes("localhost"),
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
    return res;
  } catch (error) {
    console.error("Logout error:", error);
    const res = NextResponse.json({ success: true });
    res.cookies.set(COOKIE_NAME, "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production" && !process.env.DJANGO_API_URL?.includes("localhost"),
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
    return res;
  }
}
