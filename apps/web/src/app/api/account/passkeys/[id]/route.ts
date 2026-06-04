import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";

// Auth/identity calls go to the identity service (AUTH_API_URL); default
// falls back to the core API's /auth path so local dev is unchanged.
const AUTH_API_URL =
  process.env.AUTH_API_URL ||
  `${process.env.DJANGO_API_URL || "http://localhost:8000/api/v1"}/auth`;

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    const response = await fetch(
      `${AUTH_API_URL}/passkey/credentials/${id}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
        },
      }
    );

    if (!response.ok) {
      const data = await response.json();
      return NextResponse.json(
        { error: data.detail || "Failed to delete passkey" },
        { status: response.status },
      );
    }

    return NextResponse.json({ message: "Passkey deleted successfully" });
  } catch (error) {
    console.error("Delete passkey error:", error);
    return NextResponse.json(
      { error: "Failed to delete passkey" },
      { status: 500 },
    );
  }
}
