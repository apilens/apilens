"use client";

import { useCallback } from "react";
import { useFetchWithRetry } from "./useFetchWithRetry";
import { useAsyncAction } from "./useAsyncAction";
import { useToast } from "./useToast";
import type { UserProfile } from "@/types/settings";

interface SetPasswordPayload {
  new_password: string;
  confirm_password: string;
  current_password?: string;
}

/**
 * Single source of truth for the settings/account pages. Owns the profile
 * fetch (with auto-retry) and exposes every account-level mutation as an
 * async action that:
 *   - prevents double-submission
 *   - shows toast on success/error via useToast
 *   - refetches profile after a mutation that changed server state
 *
 * Replaces the duplicate handler set in SettingsPage.tsx + AccountSettingsPage.tsx.
 */
export function useAccountSettings() {
  const toast = useToast();

  const profileQuery = useFetchWithRetry<UserProfile>({
    fetcher: async () => {
      const res = await fetch("/api/account/profile");
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to load profile");
      }
      const json = await res.json();
      return json.profile as UserProfile;
    },
    retryCount: 2,
    retryDelayMs: 1500,
  });

  const refreshProfile = useCallback(async () => {
    await profileQuery.retry();
  }, [profileQuery]);

  // ── Mutations ────────────────────────────────────────────────────

  const updateName = useAsyncAction(
    async (name: string) => {
      const res = await fetch("/api/account/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to update name");
      }
      const json = await res.json();
      profileQuery.setData(json.profile);
      return json.profile as UserProfile;
    },
    {
      onSuccess: () => toast.success("Profile updated"),
      onError: (err) => toast.error(err.message || "Couldn't update profile"),
    },
  );

  const updateTimezone = useAsyncAction(
    async (timezone: string) => {
      const res = await fetch("/api/account/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to update timezone");
      }
      const json = await res.json();
      profileQuery.setData(json.profile);
      return json.profile as UserProfile;
    },
    {
      onSuccess: () => toast.success("Timezone updated"),
      onError: (err) => toast.error(err.message || "Couldn't update timezone"),
    },
  );

  const uploadPicture = useAsyncAction(
    async (blob: Blob) => {
      const formData = new FormData();
      formData.append("file", blob, "profile.jpg");
      const res = await fetch("/api/account/profile/picture", {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to upload picture");
      }
      await refreshProfile();
    },
    {
      onSuccess: () => toast.success("Profile picture updated"),
      onError: (err) => toast.error(err.message || "Couldn't upload picture"),
    },
  );

  const removePicture = useAsyncAction(
    async () => {
      const res = await fetch("/api/account/profile/picture", { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to remove picture");
      }
      await refreshProfile();
    },
    {
      onSuccess: () => toast.success("Profile picture removed"),
      onError: (err) => toast.error(err.message || "Couldn't remove picture"),
    },
  );

  const setPassword = useAsyncAction(
    async (payload: SetPasswordPayload) => {
      const res = await fetch("/api/account/profile/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to update password");
      }
      // Password change rotates session cookie server-side; refresh profile so
      // has_password reflects the new state.
      await refreshProfile();
    },
    {
      onSuccess: () => toast.success("Password updated. Other sessions were signed out."),
      onError: (err) => toast.error(err.message || "Couldn't update password"),
    },
  );

  const logoutOthers = useAsyncAction(
    async () => {
      const res = await fetch("/api/account/logout-others", { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to sign out other devices");
      }
      const json = await res.json().catch(() => ({}));
      return json.message as string | undefined;
    },
    {
      onSuccess: (msg) => toast.success(msg || "Other devices signed out"),
      onError: (err) => toast.error(err.message || "Couldn't sign out other devices"),
    },
  );

  // Account deletion doesn't toast itself — caller handles the post-delete
  // logout/redirect. We still wrap it in useAsyncAction for the in-flight guard.
  const deleteAccount = useAsyncAction(
    async () => {
      const res = await fetch("/api/account/profile", { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to delete account");
      }
    },
    {
      onError: (err) => toast.error(err.message || "Couldn't delete account"),
    },
  );

  return {
    profile: profileQuery.data,
    isLoadingProfile: profileQuery.isLoading,
    profileError: profileQuery.error,
    refreshProfile,
    updateName,
    updateTimezone,
    uploadPicture,
    removePicture,
    setPassword,
    logoutOthers,
    deleteAccount,
  };
}

export type UseAccountSettingsReturn = ReturnType<typeof useAccountSettings>;
