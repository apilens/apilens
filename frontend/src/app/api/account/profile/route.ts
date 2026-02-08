import { NextRequest, NextResponse } from "next/server";
import { withAuth, apiResult } from "@/lib/proxy";
import { apiClient } from "@/lib/api-client";
import type { UserProfile } from "@/types/settings";
import type { DjangoUser } from "@/lib/api-client";

function toProfile(user: DjangoUser): UserProfile {
  return {
    id: user.id,
    email: user.email,
    first_name: user.first_name,
    last_name: user.last_name,
    display_name: user.display_name,
    picture: user.picture,
    email_verified: user.email_verified,
    has_password: user.has_password,
    created_at: user.created_at,
    last_login_at: user.last_login_at,
  };
}

export const GET = () =>
  withAuth(async () => {
    const result = await apiClient.getCurrentUser();
    if (result.error || !result.data) {
      return NextResponse.json(
        { error: result.error || "Failed to fetch profile" },
        { status: result.status },
      );
    }
    return NextResponse.json({ profile: toProfile(result.data) });
  });

export const PATCH = (request: NextRequest) =>
  withAuth(async () => {
    const { name } = await request.json();
    if (!name?.trim()) {
      return NextResponse.json({ error: "A valid name is required" }, { status: 400 });
    }
    const parts = name.trim().split(/\s+/);
    const result = await apiClient.updateProfile({
      first_name: parts[0] || "",
      last_name: parts.slice(1).join(" ") || "",
    });
    if (result.error || !result.data) {
      return NextResponse.json(
        { error: result.error || "Failed to update profile" },
        { status: result.status },
      );
    }
    return NextResponse.json({ profile: toProfile(result.data) });
  });

export const DELETE = () =>
  withAuth(async () => apiResult(await apiClient.deleteAccount()));
