import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";

// Identity (IAM) service base. In production AUTH_API_URL points at the
// dedicated identity service (internal http://identity:8000/v1); when unset
// it falls back to the core API's /auth path so local dev is unchanged.
const AUTH_API_URL =
  process.env.AUTH_API_URL ||
  `${process.env.DJANGO_API_URL || "http://localhost:8000/api/v1"}/auth`;
const COOKIE_NAME = "apilens_session";

export async function POST() {
  try {
    const session = await getSession();

    if (session) {
      // Revoke refresh token on Django side
      await fetch(`${AUTH_API_URL}/logout`, {
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
