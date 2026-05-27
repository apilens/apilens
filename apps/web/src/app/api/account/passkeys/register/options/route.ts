import { NextRequest, NextResponse } from "next/server";
import { getSession, setSession, clearSession } from "@/lib/session";

const DJANGO_API_URL = process.env.DJANGO_API_URL || "http://localhost:8000/api/v1";

async function refreshAccessToken(refreshToken: string): Promise<{ access_token: string; refresh_token: string } | null> {
  try {
    const response = await fetch(`${DJANGO_API_URL}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });

    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  try {
    let session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let response = await fetch(`${DJANGO_API_URL}/auth/passkey/register/options`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.accessToken}`,
      },
      body: JSON.stringify({}),
    });

    // If 401 or 422 (expired token), try to refresh
    if (response.status === 401 || response.status === 422) {
      console.log("Token expired, attempting refresh...");
      const refreshResult = await refreshAccessToken(session.refreshToken);
      if (!refreshResult) {
        console.error("Token refresh failed");
        await clearSession();
        return NextResponse.json({ error: "Session expired, please log in again" }, { status: 401 });
      }

      console.log("Token refreshed successfully, retrying request...");
      // Retry with new token
      response = await fetch(`${DJANGO_API_URL}/auth/passkey/register/options`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${refreshResult.access_token}`,
        },
        body: JSON.stringify({}),
      });

      // Get the data
      const data = await response.json();

      if (!response.ok) {
        return NextResponse.json(
          { error: data.detail || data.error || "Failed to generate registration options" },
          { status: response.status },
        );
      }

      // Update session with new tokens
      await setSession({
        accessToken: refreshResult.access_token,
        refreshToken: refreshResult.refresh_token,
        user: session.user,  // Keep existing user info
      });

      // Return success
      return NextResponse.json(data);
    }

    const data = await response.json();

    if (!response.ok) {
      return NextResponse.json(
        { error: data.detail || data.error || "Failed to generate registration options" },
        { status: response.status },
      );
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error("Passkey registration options error:", error);
    return NextResponse.json(
      { error: "Failed to generate registration options" },
      { status: 500 },
    );
  }
}
