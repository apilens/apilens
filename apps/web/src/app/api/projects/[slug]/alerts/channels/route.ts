import { type NextRequest } from "next/server";
import { proxyDjangoSend } from "@/lib/proxy";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ slug: string }> | { slug: string } },
) {
  const p = "then" in context.params ? await context.params : context.params;
  return proxyDjangoSend(request, `/projects/${p.slug}/alerts/channels`, "POST");
}
