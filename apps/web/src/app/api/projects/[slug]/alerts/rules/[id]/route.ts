import { type NextRequest } from "next/server";
import { proxyDjangoSend } from "@/lib/proxy";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ slug: string; id: string }> | { slug: string; id: string } };

export async function PATCH(request: NextRequest, context: Ctx) {
  const p = "then" in context.params ? await context.params : context.params;
  return proxyDjangoSend(request, `/projects/${p.slug}/alerts/rules/${p.id}`, "PATCH");
}

export async function DELETE(request: NextRequest, context: Ctx) {
  const p = "then" in context.params ? await context.params : context.params;
  return proxyDjangoSend(request, `/projects/${p.slug}/alerts/rules/${p.id}`, "DELETE");
}
