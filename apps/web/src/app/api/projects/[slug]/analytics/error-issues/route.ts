import { NextResponse, type NextRequest } from "next/server";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ slug: string }> | { slug: string } },
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const resolved = "then" in context.params ? await context.params : context.params;
  const { slug } = resolved;

  const url = new URL(request.url);
  const qs = url.searchParams.toString();
  const upstream = `${process.env.DJANGO_API_URL || "http://localhost:8000/api/v1"}/projects/${slug}/analytics/error-issues${qs ? `?${qs}` : ""}`;

  try {
    const res = await fetch(upstream, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${session.accessToken}`,
      },
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

// Issue lifecycle updates (resolve / ignore / reopen) — Phase 4.
import { proxyDjangoSend } from "@/lib/proxy";

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ slug: string }> | { slug: string } },
) {
  const p = "then" in context.params ? await context.params : context.params;
  return proxyDjangoSend(request, `/projects/${p.slug}/analytics/error-issues`, "PATCH");
}
