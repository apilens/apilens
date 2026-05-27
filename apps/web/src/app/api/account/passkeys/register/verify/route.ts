import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";

const DJANGO_API_URL = process.env.DJANGO_API_URL || "http://localhost:8000/api/v1";

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    console.log("Verify request - challenge received:", body.challenge);
    console.log("Verify request - credential ID:", body.credential?.id);

    const response = await fetch(`${DJANGO_API_URL}/auth/passkey/register/verify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.accessToken}`,
      },
      body: JSON.stringify({
        credential: body.credential,
        challenge: body.challenge,
        device_name: body.device_name || "Unnamed Device",
      }),
    });

    const data = await response.json();
    console.log("Django verify response:", response.status, data);

    if (!response.ok) {
      return NextResponse.json(
        { error: data.detail || "Failed to verify passkey" },
        { status: response.status },
      );
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error("Passkey registration verify error:", error);
    return NextResponse.json(
      { error: "Failed to verify passkey" },
      { status: 500 },
    );
  }
}
