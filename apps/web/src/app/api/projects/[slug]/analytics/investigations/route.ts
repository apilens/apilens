import { type NextRequest } from "next/server";
import { proxyDjangoGet, proxyDjangoSend } from "@/lib/proxy";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string }> | { slug: string } };

export async function GET(request: NextRequest, context: Ctx) {
  const p = "then" in context.params ? await context.params : context.params;
  return proxyDjangoGet(request, `/projects/${p.slug}/analytics/investigations`);
}

export async function POST(request: NextRequest, context: Ctx) {
  const p = "then" in context.params ? await context.params : context.params;
  return proxyDjangoSend(request, `/projects/${p.slug}/analytics/investigations`, "POST");
}
