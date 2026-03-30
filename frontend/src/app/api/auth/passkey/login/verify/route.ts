import { NextRequest, NextResponse } from "next/server";
import { setSession } from "@/lib/session";

const DJANGO_API_URL = process.env.DJANGO_API_URL || "http://localhost:8000/api/v1";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const response = await fetch(`${DJANGO_API_URL}/auth/passkey/login/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        credential: body.credential,
        challenge: body.challenge,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json(
        { error: data.detail || "Failed to verify passkey" },
        { status: response.status },
      );
    }

    // Get user info to create session
    const userResponse = await fetch(`${DJANGO_API_URL}/users/me`, {
      headers: {
        Authorization: `Bearer ${data.access_token}`,
      },
    });

    if (!userResponse.ok) {
      return NextResponse.json(
        { error: "Failed to get user info" },
        { status: 500 },
      );
    }

    const userData = await userResponse.json();

    // Create session cookie with tokens and user info
    await setSession({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      user: {
        id: userData.id,
        email: userData.email,
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Passkey login verify error:", error);
    return NextResponse.json(
      { error: "Failed to verify passkey" },
      { status: 500 },
    );
  }
}
