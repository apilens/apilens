import { NextRequest, NextResponse } from "next/server";

const DJANGO_API_URL = process.env.DJANGO_API_URL || "http://localhost:8000/api/v1";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { email } = body;

    if (!email) {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }

    // Check with Django backend if user exists and has password/passkey
    const response = await fetch(`${DJANGO_API_URL}/auth/check-user`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });

    if (!response.ok) {
      // User doesn't exist or error occurred - return safe defaults
      return NextResponse.json({
        exists: false,
        has_password: false,
        has_passkey: false,
      });
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error("Check user error:", error);
    // Return safe defaults on error
    return NextResponse.json({
      exists: false,
      has_password: false,
      has_passkey: false,
    });
  }
}
