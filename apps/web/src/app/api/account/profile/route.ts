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
    timezone: user.timezone,
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
    const { name, timezone } = await request.json();
    const nextTimezone =
      typeof timezone === "string" && timezone.trim().length > 0 ? timezone.trim() : undefined;
    const hasName = typeof name === "string" && name.trim().length > 0;

    if (!hasName && !nextTimezone) {
      return NextResponse.json(
        { error: "Provide at least one field to update" },
        { status: 400 },
      );
    }

    const parts = hasName ? name.trim().split(/\s+/) : [];
    const result = await apiClient.updateProfile({
      ...(hasName ? { first_name: parts[0] || "", last_name: parts.slice(1).join(" ") || "" } : {}),
      ...(nextTimezone ? { timezone: nextTimezone } : {}),
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
