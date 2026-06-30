import { NextRequest, NextResponse } from "next/server";

// Identity (IAM) service base — same resolution as the other public auth proxies.
const AUTH_API_URL =
  process.env.AUTH_API_URL ||
  `${process.env.DJANGO_API_URL || "http://localhost:8000/api/v1"}/auth`;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (!body.token) {
      return NextResponse.json({ error: "Token is required" }, { status: 400 });
    }

    const response = await fetch(`${AUTH_API_URL}/invite-info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: body.token }),
    });

    const data = await response.json();
    if (!response.ok) {
      return NextResponse.json(
        { error: data.detail || data.message || "Unable to load invitation" },
        { status: response.status },
      );
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error("Invite info error:", error);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
