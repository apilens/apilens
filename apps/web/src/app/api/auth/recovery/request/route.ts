import { NextRequest, NextResponse } from "next/server";

const DJANGO_API_URL = process.env.DJANGO_API_URL || "http://localhost:8000/api/v1";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    if (!body.email) {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }

    const clientIp =
      request.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
      request.headers.get("x-real-ip") ||
      "";

    const response = await fetch(`${DJANGO_API_URL}/auth/recovery/request`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(clientIp ? { "X-Forwarded-For": clientIp } : {}),
      },
      body: JSON.stringify({ email: body.email }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return NextResponse.json(
        { error: data.detail || data.error || data.message || "Couldn't start recovery" },
        { status: response.status },
      );
    }
    return NextResponse.json(data);
  } catch (error) {
    console.error("Recovery request error:", error);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
