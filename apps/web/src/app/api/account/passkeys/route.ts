import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";

const DJANGO_API_URL = process.env.DJANGO_API_URL || "http://localhost:8000/api/v1";

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const response = await fetch(`${DJANGO_API_URL}/auth/passkey/credentials`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
      },
    });

    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json(
        { error: data.detail || "Failed to fetch passkeys" },
        { status: response.status },
      );
    }

    return NextResponse.json({ passkeys: data });
  } catch (error) {
    console.error("Fetch passkeys error:", error);
    return NextResponse.json(
      { error: "Failed to fetch passkeys" },
      { status: 500 },
    );
  }
}
