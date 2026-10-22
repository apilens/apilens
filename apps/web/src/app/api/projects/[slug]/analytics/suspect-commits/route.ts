import { type NextRequest } from "next/server";
import { proxyDjangoGet } from "@/lib/proxy";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ slug: string }> | { slug: string } },
) {
  const p = "then" in context.params ? await context.params : context.params;
  return proxyDjangoGet(request, `/projects/${p.slug}/analytics/suspect-commits`);
}
