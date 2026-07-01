"use client";

import { useRouter } from "next/navigation";
import { useAuth } from "@/components/providers/AuthProvider";
import { useAccountSettings } from "@/hooks/useAccountSettings";
import PageHeader from "@/components/dashboard/PageHeader";
import AccountSettingsSidebar, { AccountSettingsTab } from "./AccountSettingsSidebar";
import GeneralSection from "@/components/settings/GeneralSection";
import ProfileSection from "@/components/settings/ProfileSection";
import TimezoneSection from "@/components/settings/TimezoneSection";
import SessionsSection from "@/components/settings/SessionsSection";
import LoginMethodsSection from "@/components/settings/LoginMethodsSection";
import TwoFactorSection from "@/components/settings/TwoFactorSection";
import DangerZoneSection from "@/components/settings/DangerZoneSection";
import SectionError from "@/components/ui/SectionError";
import ErrorBoundary from "@/components/ui/ErrorBoundary";

interface AccountSettingsPageProps {
  initialTab?: AccountSettingsTab;
}

export default function AccountSettingsPage({ initialTab = "general" }: AccountSettingsPageProps) {
  const router = useRouter();
  const { isLoading: isUserLoading, logout, refreshUser } = useAuth();
  const activeTab = initialTab;
  const {
    profile,
    isLoadingProfile,
    profileError,
    refreshProfile,
    updateName,
    updateTimezone,
    setPassword,
    logoutOthers,
    deleteAccount,
  } = useAccountSettings();

  // ── Section adapters ─────────────────────────────────────────────
  // Sections still accept thin handler props; the hook owns the action logic.

  const handleUpdateName = async (name: string) => {
    const next = await updateName.run(name);
    if (next) await refreshUser();
  };

  const handleUpdateTimezone = async (timezone: string) => {
    const next = await updateTimezone.run(timezone);
    if (next) await refreshUser();
  };

  const handleSetPassword = async (data: {
    new_password: string;
    confirm_password: string;
    current_password?: string;
  }) => {
    const result = await setPassword.run(data);
    // setPassword resolves to undefined on failure (errors are toasted).
    // Caller surface: re-throw so inline forms can keep their own error state.
    if (setPassword.error) throw setPassword.error;
    void result;
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
        <div className="settings-page-loading">
          <div className="loading-spinner" />
        </div>
      </div>
    );
  }

  // If the profile fetch failed outright (network, auth, etc.), surface a
  // single retry-able error instead of letting every section error out.
  if (profileError && !profile) {
    return (
      <div className="settings-page">
        <PageHeader
          title="Account Settings"
          onBack={() => router.push("/projects")}
          backLabel="Back to Projects"
        />
        <div style={{ padding: "32px 24px", maxWidth: "560px", margin: "0 auto" }}>
          <SectionError
            title="Couldn't load your account"
            message={profileError.message || "Check your connection and try again."}
            onRetry={refreshProfile}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="settings-page">
      <PageHeader
        title="Account Settings"
        onBack={() => router.push("/projects")}
        backLabel="Back to Projects"
      />

      <div className="settings-page-body">
        <AccountSettingsSidebar activeTab={activeTab} />

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
        </div>
      </div>
    </div>
  );
}
