import { NextRequest, NextResponse } from "next/server";

// Identity (IAM) service base. In production AUTH_API_URL points at the
// dedicated identity service (internal http://identity:8000/v1); when unset
// it falls back to the core API's /auth path so local dev is unchanged.
const AUTH_API_URL =
  process.env.AUTH_API_URL ||
  `${process.env.DJANGO_API_URL || "http://localhost:8000/api/v1"}/auth`;

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const token = url.searchParams.get("token");
    if (!token) {
      return NextResponse.json({ error: "Missing token" }, { status: 400 });
    }

    const response = await fetch(
      `${AUTH_API_URL}/recovery/status?token=${encodeURIComponent(token)}`,
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
