import { type NextRequest } from "next/server";
import { proxyDjangoSend } from "@/lib/proxy";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  return proxyDjangoSend(request, `/integrations/github/complete`, "POST");
}
