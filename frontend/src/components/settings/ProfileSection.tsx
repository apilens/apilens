"use client";

import { useState } from "react";
import { Pencil, Check, X, Loader2 } from "lucide-react";
// import { Camera } from "lucide-react"; // Commented out — no picture upload
import { UserProfile } from "@/types/settings";
import SettingsCard from "./SettingsCard";
// import ProfilePictureEditor from "./ProfilePictureEditor"; // Commented out — no picture upload

// Get initials from name (first letter of first name + first letter of last name)
function getInitials(name?: string): string {
  if (!name) return "U";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) {
    return parts[0].charAt(0).toUpperCase();
  }
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

// Commented out — no picture upload/display
// function isValidPictureUrl(url: string | undefined): boolean {
//   if (!url || typeof url !== 'string' || url.length === 0) {
//     return false;
//   }
//   return url.startsWith('data:image/');
// }

interface ProfileSectionProps {
  profile: UserProfile | null;
  onUpdateName: (name: string) => Promise<void>;
  // onUpdatePicture?: (pictureData: string) => Promise<void>; // Commented out — no picture upload
  // onRemovePicture?: () => Promise<void>; // Commented out — no picture upload
}

export default function ProfileSection({
  profile,
  onUpdateName,
  // onUpdatePicture, // Commented out — no picture upload
  // onRemovePicture  // Commented out — no picture upload
}: ProfileSectionProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editedName, setEditedName] = useState(profile?.name || "");
  const [isSaving, setIsSaving] = useState(false);
  // const [imgError, setImgError] = useState(false); // Commented out — no picture display
  // const [isPictureEditorOpen, setIsPictureEditorOpen] = useState(false); // Commented out — no picture upload

  // Commented out — no picture display
  // const hasValidPicture = isValidPictureUrl(profile?.picture);
  // useEffect(() => { setImgError(false); }, [profile?.picture]);

  const handleStartEdit = () => {
    setEditedName(profile?.name || "");
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    setEditedName(profile?.name || "");
    setIsEditing(false);
  };

  const handleSave = async () => {
    if (!editedName.trim() || editedName === profile?.name) {
      handleCancelEdit();
      return;
    }

    setIsSaving(true);
    try {
      await onUpdateName(editedName.trim());
      setIsEditing(false);
    } finally {
      setIsSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSave();
    } else if (e.key === "Escape") {
      handleCancelEdit();
    }
  };

  // Commented out — no picture upload
  // const handleSavePicture = async (pictureData: string) => {
  //   if (onUpdatePicture) {
  //     await onUpdatePicture(pictureData);
  //     setImgError(false);
  //   }
  // };

  if (!profile) {
    return (
      <SettingsCard title="Profile" description="Your personal information">
        <div className="profile-skeleton">
          <div className="profile-avatar-skeleton" />
          <div className="profile-info-skeleton">
            <div className="skeleton-line skeleton-line-lg" />
            <div className="skeleton-line skeleton-line-md" />
          </div>
        </div>
      </SettingsCard>
    );
  }

  return (
    <SettingsCard
      title="Profile"
      description="Your personal information"
      action={
        !isEditing && (
          <button className="settings-btn settings-btn-ghost" onClick={handleStartEdit}>
            <Pencil size={14} />
            Edit
          </button>
        )
      }
    >
      <div className="profile-header">
        {/* Picture upload wrapper commented out — initials only, no click-to-edit */}
        {/* <div
          className="profile-avatar-wrapper"
          onClick={() => setIsPictureEditorOpen(true)}
        >
          <div className="profile-avatar-large">
            {hasValidPicture && !imgError ? (
              <img
                src={profile.picture}
                alt={profile.name}
                onError={() => setImgError(true)}
              />
            ) : (
              <span className="profile-avatar-initial">
                {getInitials(profile.name)}
              </span>
            )}
          </div>
          <div className="profile-avatar-edit">
            <Camera size={20} className="profile-avatar-edit-icon" />
          </div>
        </div> */}
        <div className="profile-avatar-large">
          <span className="profile-avatar-initial">
            {getInitials(profile.name)}
          </span>
        </div>
        <div className="profile-info">
          {isEditing ? (
            <div className="profile-edit-row">
              <input
                type="text"
                className="profile-edit-input"
                value={editedName}
                onChange={(e) => setEditedName(e.target.value)}
                onKeyDown={handleKeyDown}
                autoFocus
                disabled={isSaving}
              />
              <div className="profile-edit-actions">
                <button
                  className="settings-btn settings-btn-icon settings-btn-primary"
                  onClick={handleSave}
                  disabled={isSaving}
                  aria-label="Save"
                >
                  {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                </button>
                <button
                  className="settings-btn settings-btn-icon settings-btn-ghost"
                  onClick={handleCancelEdit}
                  disabled={isSaving}
                  aria-label="Cancel"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          ) : (
            <p className="profile-name">{profile.name}</p>
          )}
          <p className="profile-email">{profile.email}</p>
        </div>
      </div>

      {/* ProfilePictureEditor commented out — no picture upload */}
      {/* <ProfilePictureEditor
        isOpen={isPictureEditorOpen}
        onClose={() => setIsPictureEditorOpen(false)}
        onSave={handleSavePicture}
        onRemove={hasValidPicture ? onRemovePicture : undefined}
        currentPicture={hasValidPicture ? profile.picture : undefined}
      /> */}
    </SettingsCard>
  );
}
