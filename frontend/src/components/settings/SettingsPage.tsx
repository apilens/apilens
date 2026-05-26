"use client";

import { useAuth } from "@/components/providers/AuthProvider";
import { useAccountSettings } from "@/hooks/useAccountSettings";
import SettingsSidebar, { SettingsTab } from "./SettingsSidebar";
import GeneralSection from "./GeneralSection";
import ProfileSection from "./ProfileSection";
import TimezoneSection from "./TimezoneSection";
import LoginMethodsSection from "./LoginMethodsSection";
import TwoFactorSection from "./TwoFactorSection";
import SessionsSection from "./SessionsSection";
import ApiKeysSection from "./ApiKeysSection";
import DangerZoneSection from "./DangerZoneSection";
import SectionError from "@/components/ui/SectionError";
import ErrorBoundary from "@/components/ui/ErrorBoundary";

interface SettingsPageProps {
  initialTab?: SettingsTab;
}

export default function SettingsPage({ initialTab = "general" }: SettingsPageProps) {
  const { isLoading: isUserLoading, logout, refreshUser } = useAuth();
  const activeTab = initialTab;
  const {
    profile,
    isLoadingProfile,
    profileError,
    refreshProfile,
    updateName,
    updateTimezone,
    uploadPicture,
    removePicture,
    setPassword,
    logoutOthers,
    deleteAccount,
  } = useAccountSettings();

  const handleUpdateName = async (name: string) => {
    const next = await updateName.run(name);
    if (next) await refreshUser();
  };

  const handleUpdateTimezone = async (timezone: string) => {
    const next = await updateTimezone.run(timezone);
    if (next) await refreshUser();
  };

  const handlePictureUpload = async (blob: Blob) => {
    await uploadPicture.run(blob);
    await refreshUser();
  };

  const handlePictureRemove = async () => {
    await removePicture.run();
    await refreshUser();
  };

  const handleSetPassword = async (data: {
    new_password: string;
    confirm_password: string;
    current_password?: string;
  }) => {
    await setPassword.run(data);
    if (setPassword.error) throw setPassword.error;
  };

  const handleLogoutOthers = async () => {
    await logoutOthers.run();
  };

  const handleDeleteAccount = async () => {
    await deleteAccount.run();
    if (!deleteAccount.error) {
      logout();
    }
  };

  if (isUserLoading || isLoadingProfile) {
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

  if (profileError && !profile) {
    return (
      <div className="settings-page">
        <div className="settings-page-header">
          <h1 className="settings-page-title">Settings</h1>
        </div>
        <div style={{ padding: "32px 24px", maxWidth: "560px", margin: "0 auto" }}>
          <SectionError
            title="Couldn't load your settings"
            message={profileError.message || "Check your connection and try again."}
            onRetry={refreshProfile}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="settings-page">
      <div className="settings-page-header">
        <h1 className="settings-page-title">Settings</h1>
      </div>

      <div className="settings-page-body">
        <SettingsSidebar activeTab={activeTab} />

        <div className="settings-page-content">
          {activeTab === "general" && (
            <ErrorBoundary>
              <GeneralSection />
            </ErrorBoundary>
          )}
          {activeTab === "account" && (
            <div className="settings-section-content">
              <ErrorBoundary>
                <ProfileSection
                  profile={profile}
                  onUpdateName={handleUpdateName}
                  onPictureUpload={handlePictureUpload}
                  onPictureRemove={handlePictureRemove}
                />
              </ErrorBoundary>
              <ErrorBoundary>
                <TimezoneSection
                  timezone={profile?.timezone || "UTC"}
                  onUpdateTimezone={handleUpdateTimezone}
                />
              </ErrorBoundary>
              <ErrorBoundary>
                <SessionsSection
                  onLogoutOthers={handleLogoutOthers}
                  timezone={profile?.timezone || "UTC"}
                  lastLoginAt={profile?.last_login_at || null}
                  memberSince={profile?.created_at || null}
                />
              </ErrorBoundary>
              <ErrorBoundary>
                <LoginMethodsSection
                  email={profile?.email}
                  hasPassword={profile?.has_password}
                  onSetPassword={handleSetPassword}
                />
              </ErrorBoundary>
              <ErrorBoundary>
                <TwoFactorSection hasPassword={!!profile?.has_password} />
              </ErrorBoundary>
              <ErrorBoundary>
                <DangerZoneSection onDeleteAccount={handleDeleteAccount} />
              </ErrorBoundary>
            </div>
          )}
          {activeTab === "api-keys" && (
            <div className="settings-section-content">
              <ErrorBoundary>
                <ApiKeysSection />
              </ErrorBoundary>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
