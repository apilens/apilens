import { NextRequest, NextResponse } from "next/server";
import { setSession } from "@/lib/session";

const DJANGO_API_URL = process.env.DJANGO_API_URL || "http://localhost:8000/api/v1";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const response = await fetch(`${DJANGO_API_URL}/auth/2fa/verify-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const data = await response.json();
      return NextResponse.json(
        { error: data.detail || "Verification failed" },
        { status: response.status }
      );
    }

    const data = await response.json();

    // Fetch user info
    const userResponse = await fetch(`${DJANGO_API_URL}/users/me`, {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });

    if (!userResponse.ok) {
      return NextResponse.json(
        { error: "Failed to fetch user info" },
        { status: 500 }
      );
    }

    const userData = await userResponse.json();

    // Create session
    await setSession({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      user: { id: userData.id, email: userData.email },
    }, body.remember_me);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("2FA verify login error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
