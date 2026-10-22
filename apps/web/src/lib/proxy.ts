import { NextResponse, type NextRequest } from "next/server";
import { getSession, type SessionData } from "@/lib/session";
import { refreshTokens, type ApiResponse } from "@/lib/api-client";

const DJANGO_API_URL = process.env.DJANGO_API_URL || "http://localhost:8000/api/v1";

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

/**
 * Fetches `url` with the session's access token, transparently refreshing
 * and retrying once on a 401 instead of returning the stale failure.
 *
 * Routes that build their own fetch to Django/identity directly (rather than
 * going through apiClient) were missing this — the access token expiring
 * mid-session made them fail permanently until the user reloaded the page.
 */
export async function fetchWithRefresh(
  url: string,
  session: SessionData,
  init: RequestInit = {},
): Promise<Response> {
  const request = (accessToken: string) =>
    fetch(url, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${accessToken}` },
    });

  const res = await request(session.accessToken);
  if (res.status !== 401) {
    return res;
  }

  const refreshed = await refreshTokens(session.refreshToken);
  if (!refreshed) {
    return res;
  }

  return request(refreshed.accessToken);
}

/**
 * Proxies a GET request to the core Django API at `path`, forwarding the
 * incoming query string and passing the upstream response through verbatim
 * (status + content-type + body). Handles auth + token refresh.
 */
export async function proxyDjangoGet(
  request: NextRequest,
  path: string,
): Promise<NextResponse> {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const qs = new URL(request.url).searchParams.toString();
  const upstream = `${DJANGO_API_URL}${path}${qs ? `?${qs}` : ""}`;

  try {
    const res = await fetchWithRefresh(upstream, session, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
    });

    const body = await res.text();
    return new NextResponse(body, {
      status: res.status,
      headers: { "Content-Type": res.headers.get("content-type") || "application/json" },
    });
  } catch {
    return NextResponse.json({ error: "Upstream request failed" }, { status: 502 });
  }
}

/**
 * Like proxyDjangoGet, but for write methods: forwards the JSON body (if any)
 * to the Django API with the session's bearer token.
 */
export async function proxyDjangoSend(
  request: NextRequest,
  path: string,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
): Promise<NextResponse> {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const qs = new URL(request.url).searchParams.toString();
  const upstream = `${DJANGO_API_URL}${path}${qs ? `?${qs}` : ""}`;
  let body: string | undefined;
  try {
    const text = await request.text();
    body = text || undefined;
  } catch {
    body = undefined;
  }

  try {
    const res = await fetchWithRefresh(upstream, session, {
      method,
      headers: { "Content-Type": "application/json" },
      body,
      cache: "no-store",
    });
    const resBody = await res.text();
    return new NextResponse(resBody, {
      status: res.status,
      headers: { "Content-Type": res.headers.get("content-type") || "application/json" },
    });
  } catch {
    return NextResponse.json({ error: "Upstream request failed" }, { status: 502 });
  }
}
