import { NextRequest, NextResponse } from "next/server";

const DJANGO_API_URL = process.env.DJANGO_API_URL || "http://localhost:8000/api/v1";

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const token = url.searchParams.get("token");
    if (!token) {
      return NextResponse.json({ error: "Missing token" }, { status: 400 });
    }

    const response = await fetch(
      `${DJANGO_API_URL}/auth/recovery/status?token=${encodeURIComponent(token)}`,
      { method: "GET" },
    );

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return NextResponse.json(
        { error: data.detail || data.error || "Status check failed" },
        { status: response.status },
      );
    }
    return NextResponse.json(data);
  } catch (error) {
    console.error("Recovery status error:", error);
    return NextResponse.json({ error: "Something went wrong" }, { status: 500 });
  }
}
