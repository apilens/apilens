"use client";

import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/components/providers/AuthProvider";
import { ArrowLeft, X, Check } from "lucide-react";
import Link from "next/link";
import { UserProfile } from "@/types/settings";
import AccountSettingsSidebar, { AccountSettingsTab } from "./AccountSettingsSidebar";
import GeneralSection from "@/components/settings/GeneralSection";
import ProfileSection from "@/components/settings/ProfileSection";
import TimezoneSection from "@/components/settings/TimezoneSection";
import SessionsSection from "@/components/settings/SessionsSection";
import LoginMethodsSection from "@/components/settings/LoginMethodsSection";
import DangerZoneSection from "@/components/settings/DangerZoneSection";

interface ToastState {
  type: "success" | "error";
  message: string;
}

interface AccountSettingsPageProps {
  initialTab?: AccountSettingsTab;
}

export default function AccountSettingsPage({ initialTab = "general" }: AccountSettingsPageProps) {
  const { user, isLoading: isUserLoading, logout, refreshUser } = useAuth();
  const activeTab = initialTab;
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [isLoadingData, setIsLoadingData] = useState(true);
  const [toast, setToast] = useState<ToastState | null>(null);

  const showToast = useCallback((type: "success" | "error", message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 5000);
  }, []);

  const fetchProfile = useCallback(async () => {
    try {
      const response = await fetch("/api/account/profile");
      if (!response.ok) throw new Error("Failed to fetch profile");
      const data = await response.json();
      setProfile(data.profile);
    } catch (error) {
      console.error("Error fetching profile:", error);
    }
  }, []);

  useEffect(() => {
    if (!isUserLoading && user) {
      fetchProfile().finally(() => setIsLoadingData(false));
    }
  }, [isUserLoading, user, fetchProfile]);

  const handleUpdateName = async (name: string) => {
    try {
      const response = await fetch("/api/account/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to update profile");
      }

      const data = await response.json();
      setProfile(data.profile);
      await refreshUser();
      showToast("success", "Profile updated successfully");
    } catch (error) {
      showToast("error", error instanceof Error ? error.message : "Failed to update profile");
    }
  };

  const handleUpdateTimezone = async (timezone: string) => {
    try {
      const response = await fetch("/api/account/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to update timezone");
      }

      const data = await response.json();
      setProfile(data.profile);
      showToast("success", "Timezone updated");
    } catch (error) {
      showToast("error", error instanceof Error ? error.message : "Failed to update timezone");
    }
  };

  const handlePictureUpload = async (blob: Blob) => {
    try {
      const formData = new FormData();
      formData.append("file", blob, "profile.jpg");

      const response = await fetch("/api/account/profile/picture", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to upload picture");
      }

      await fetchProfile();
      await refreshUser();
      showToast("success", "Profile picture updated");
    } catch (error) {
      showToast("error", error instanceof Error ? error.message : "Failed to upload picture");
    }
  };

  const handlePictureRemove = async () => {
    try {
      const response = await fetch("/api/account/profile/picture", {
        method: "DELETE",
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to remove picture");
      }

      await fetchProfile();
      await refreshUser();
      showToast("success", "Profile picture removed");
    } catch (error) {
      showToast("error", error instanceof Error ? error.message : "Failed to remove picture");
    }
  };

  const handleDeleteAccount = async () => {
    try {
      const response = await fetch("/api/account/profile", {
        method: "DELETE",
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to delete account");
      }

      logout();
    } catch (error) {
      showToast("error", error instanceof Error ? error.message : "Failed to delete account");
    }
  };

  const handleSetPassword = async (data: {
    new_password: string;
    confirm_password: string;
    current_password?: string;
  }) => {
    const response = await fetch("/api/account/profile/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error || "Failed to set password");
    }

    await fetchProfile();
    await refreshUser();
    showToast("success", "Password updated successfully");
  };

  const handleLogoutAll = async () => {
    try {
      const response = await fetch("/api/account/logout-all", {
        method: "POST",
      });

      if (!response.ok) {
        throw new Error("Failed to logout all devices");
      }

      await logout();
    } catch (error) {
      showToast("error", error instanceof Error ? error.message : "Failed to logout all devices");
    }
  };

  if (isUserLoading || isLoadingData) {
    return (
      <div className="account-settings-container">
        <div className="account-settings-header">
          <Link href="/apps" className="account-settings-back">
            <ArrowLeft size={16} />
            Back to Apps
          </Link>
          <h1 className="account-settings-title">Account Settings</h1>
        </div>
        <div className="settings-page-loading">
          <div className="loading-spinner" />
        </div>
      </div>
    );
  }

  return (
    <div className="account-settings-container">
      {toast && (
        <div className={`settings-toast settings-toast-${toast.type}`}>
          <div className="settings-toast-icon">
            {toast.type === "success" ? <Check size={16} /> : <X size={16} />}
          </div>
          <span>{toast.message}</span>
          <button className="settings-toast-close" onClick={() => setToast(null)}>
            <X size={14} />
          </button>
        </div>
      )}

      <div className="account-settings-header">
        <Link href="/apps" className="account-settings-back">
          <ArrowLeft size={16} />
          Back to Apps
        </Link>
        <h1 className="account-settings-title">Account Settings</h1>
      </div>

      <div className="account-settings-body">
        <AccountSettingsSidebar activeTab={activeTab} />

        <div className="account-settings-content">
          {activeTab === "general" && <GeneralSection />}
          {activeTab === "account" && (
            <div className="settings-section-content">
              <ProfileSection
                profile={profile}
                onUpdateName={handleUpdateName}
                onPictureUpload={handlePictureUpload}
                onPictureRemove={handlePictureRemove}
              />
              <TimezoneSection
                timezone={profile?.timezone || "UTC"}
                onUpdateTimezone={handleUpdateTimezone}
              />
              <SessionsSection
                onLogoutAll={handleLogoutAll}
                timezone={profile?.timezone || "UTC"}
                lastLoginAt={profile?.last_login_at || null}
                memberSince={profile?.created_at || null}
              />
              <LoginMethodsSection
                email={profile?.email}
                hasPassword={profile?.has_password}
                onSetPassword={handleSetPassword}
              />
              <DangerZoneSection onDeleteAccount={handleDeleteAccount} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
