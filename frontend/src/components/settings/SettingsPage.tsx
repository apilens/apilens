"use client";

import { useState, useEffect, useCallback } from "react";
import { useUser } from "@auth0/nextjs-auth0/client";
import { X, Check } from "lucide-react";
import { ConnectedAccount, UserProfile } from "@/types/settings";
import SettingsSidebar, { SettingsTab } from "./SettingsSidebar";
import GeneralSection from "./GeneralSection";
import AccountSection from "./AccountSection";

interface ToastState {
  type: "success" | "error";
  message: string;
}

interface SettingsPageProps {
  initialTab?: SettingsTab;
}

export default function SettingsPage({ initialTab = "general" }: SettingsPageProps) {
  const { user, isLoading: isUserLoading } = useUser();
  const activeTab = initialTab;
  const [identities, setIdentities] = useState<ConnectedAccount[]>([]);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [isLoadingData, setIsLoadingData] = useState(true);
  const [toast, setToast] = useState<ToastState | null>(null);

  const showToast = useCallback((type: "success" | "error", message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 5000);
  }, []);

  const fetchIdentities = useCallback(async () => {
    try {
      const response = await fetch("/api/account/identities");
      if (!response.ok) throw new Error("Failed to fetch identities");
      const data = await response.json();
      setIdentities(data.identities);
    } catch (error) {
      console.error("Error fetching identities:", error);
      showToast("error", "Failed to load connected accounts");
    }
  }, [showToast]);

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
      Promise.all([fetchIdentities(), fetchProfile()]).finally(() => {
        setIsLoadingData(false);
      });
    }
  }, [isUserLoading, user, fetchIdentities, fetchProfile]);

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
      showToast("success", "Profile updated successfully");
    } catch (error) {
      console.error("Error updating profile:", error);
      showToast("error", error instanceof Error ? error.message : "Failed to update profile");
    }
  };

  // Commented out — no picture upload
  // const handleUpdatePicture = async (pictureData: string) => {
  //   try {
  //     const response = await fetch("/api/account/profile", {
  //       method: "PATCH",
  //       headers: { "Content-Type": "application/json" },
  //       body: JSON.stringify({ picture: pictureData }),
  //     });
  //     if (!response.ok) {
  //       const data = await response.json();
  //       throw new Error(data.error || "Failed to update profile picture");
  //     }
  //     const data = await response.json();
  //     setProfile(data.profile);
  //     showToast("success", "Profile picture updated");
  //   } catch (error) {
  //     console.error("Error updating profile picture:", error);
  //     showToast("error", error instanceof Error ? error.message : "Failed to update profile picture");
  //   }
  // };

  // const handleRemovePicture = async () => {
  //   try {
  //     const response = await fetch("/api/account/profile", {
  //       method: "PATCH",
  //       headers: { "Content-Type": "application/json" },
  //       body: JSON.stringify({ picture: "" }),
  //     });
  //     if (!response.ok) {
  //       const data = await response.json();
  //       throw new Error(data.error || "Failed to remove profile picture");
  //     }
  //     const data = await response.json();
  //     setProfile(data.profile);
  //     showToast("success", "Profile picture removed");
  //   } catch (error) {
  //     console.error("Error removing profile picture:", error);
  //     showToast("error", error instanceof Error ? error.message : "Failed to remove profile picture");
  //   }
  // };

  const handleDeleteAccount = async () => {
    try {
      const response = await fetch("/api/account/profile", {
        method: "DELETE",
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to delete account");
      }

      window.location.href = "/auth/logout";
    } catch (error) {
      console.error("Error deleting account:", error);
      showToast("error", error instanceof Error ? error.message : "Failed to delete account");
    }
  };

  if (isUserLoading || isLoadingData) {
    return (
      <div className="settings-page">
        <div className="settings-page-header">
          <h1 className="settings-page-title">Settings</h1>
        </div>
        <div className="settings-page-loading">
          <div className="loading-spinner" />
        </div>
      </div>
    );
  }

  return (
    <div className="settings-page">
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

      <div className="settings-page-header">
        <h1 className="settings-page-title">Settings</h1>
      </div>

      <div className="settings-page-body">
        <SettingsSidebar activeTab={activeTab} />

        <div className="settings-page-content">
          {activeTab === "general" && <GeneralSection />}
          {activeTab === "account" && (
            <AccountSection
              profile={profile}
              identities={identities}
              onUpdateName={handleUpdateName}
              // onUpdatePicture={handleUpdatePicture} // Commented out — no picture upload
              // onRemovePicture={handleRemovePicture} // Commented out — no picture upload
              onRefreshIdentities={fetchIdentities}
              onDeleteAccount={handleDeleteAccount}
            />
          )}
        </div>
      </div>
    </div>
  );
}
