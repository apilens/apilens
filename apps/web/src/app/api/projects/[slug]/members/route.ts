import { NextResponse } from "next/server";
import { withAuth, apiResult } from "@/lib/proxy";
import { apiClient } from "@/lib/api-client";

export const GET = (
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) =>
  withAuth(async () => apiResult(await apiClient.getProjectMembers((await params).slug)));

export const POST = (
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) =>
  withAuth(async () => {
    const body = await request.json();
    const email = body.email?.trim();
    const role = body.role?.trim() || "member";
    if (!email) {
      return NextResponse.json({ error: "Email is required" }, { status: 400 });
    }
    return apiResult(await apiClient.inviteProjectMember((await params).slug, email, role));
  });
