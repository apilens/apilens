"use client";

import { ConnectedAccount, UserProfile } from "@/types/settings";
import ProfileSection from "./ProfileSection";
import ConnectedAccountsSection from "./ConnectedAccountsSection";
import DangerZoneSection from "./DangerZoneSection";

interface AccountSectionProps {
  profile: UserProfile | null;
  identities: ConnectedAccount[];
  onUpdateName: (name: string) => Promise<void>;
  // onUpdatePicture: (pictureData: string) => Promise<void>; // Commented out — no picture upload
  // onRemovePicture: () => Promise<void>; // Commented out — no picture upload
  onRefreshIdentities: () => Promise<void>;
  onDeleteAccount: () => Promise<void>;
}

export default function AccountSection({
  profile,
  identities,
  onUpdateName,
  // onUpdatePicture, // Commented out — no picture upload
  // onRemovePicture, // Commented out — no picture upload
  onRefreshIdentities,
  onDeleteAccount,
}: AccountSectionProps) {
  return (
    <div className="settings-section-content">
      <ProfileSection
        profile={profile}
        onUpdateName={onUpdateName}
        // onUpdatePicture={onUpdatePicture} // Commented out — no picture upload
        // onRemovePicture={onRemovePicture} // Commented out — no picture upload
      />

      <ConnectedAccountsSection
        identities={identities}
        onRefresh={onRefreshIdentities}
      />

      <DangerZoneSection onDeleteAccount={onDeleteAccount} />
    </div>
  );
}
