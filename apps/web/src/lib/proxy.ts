import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import type { ApiResponse } from "@/lib/api-client";

/**
 * Wraps a route handler with session authentication and error handling.
 * Eliminates the repetitive try/catch + session check boilerplate.
 */
export async function withAuth(
  handler: () => Promise<NextResponse>,
): Promise<NextResponse> {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  try {
    return await handler();
  } catch (error) {
    console.error("Route error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * Converts an apiClient result into a NextResponse.
 * Optionally wraps data under a key (e.g. { sessions: [...] }).
 */
export function apiResult<T>(
  result: ApiResponse<T>,
  wrapKey?: string,
): NextResponse {
  if (result.error || !result.data) {
    return NextResponse.json(
      { error: result.error || "Request failed" },
      { status: result.status },
    );
  }
  return NextResponse.json(wrapKey ? { [wrapKey]: result.data } : result.data);
}
