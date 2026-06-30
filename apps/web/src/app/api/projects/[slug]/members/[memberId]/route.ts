import { NextResponse } from "next/server";
import { withAuth, apiResult } from "@/lib/proxy";
import { apiClient } from "@/lib/api-client";

export const PATCH = (
  request: Request,
  { params }: { params: Promise<{ slug: string; memberId: string }> },
) =>
  withAuth(async () => {
    const body = await request.json();
    const role = body.role?.trim();
    if (!role) {
      return NextResponse.json({ error: "Role is required" }, { status: 400 });
    }
    const { slug, memberId } = await params;
    return apiResult(await apiClient.updateMemberRole(slug, memberId, role));
  });

export const DELETE = (
  _request: Request,
  { params }: { params: Promise<{ slug: string; memberId: string }> },
) =>
  withAuth(async () => {
    const { slug, memberId } = await params;
    return apiResult(await apiClient.removeProjectMember(slug, memberId));
  });
