"use client";

import { useState } from "react";
import { Check, X, Loader2, Pencil } from "lucide-react";
import { UserProfile } from "@/types/settings";
import SettingsCard from "./SettingsCard";
import UserAvatar from "@/components/shared/UserAvatar";
import ProfilePictureEditor from "./ProfilePictureEditor";
import ImageViewModal from "./ImageViewModal";

interface ProfileSectionProps {
  profile: UserProfile | null;
  onUpdateName: (name: string) => Promise<void>;
  onPictureUpload: (blob: Blob) => Promise<void>;
  onPictureRemove: () => Promise<void>;
}

export default function ProfileSection({
  profile,
  onUpdateName,
  onPictureUpload,
  onPictureRemove,
}: ProfileSectionProps) {
  const displayName = profile?.display_name || "";
  const [isEditing, setIsEditing] = useState(false);
  const [editedName, setEditedName] = useState(displayName);
  const [isSaving, setIsSaving] = useState(false);
  const [showEditor, setShowEditor] = useState(false);
  const [showImageView, setShowImageView] = useState(false);

  const handleStartEdit = () => {
    setEditedName(displayName);
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    setEditedName(displayName);
    setIsEditing(false);
  };

  const handleSave = async () => {
    if (!editedName.trim() || editedName === displayName) {
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

  const handleAvatarClick = () => {
    if (profile?.picture) {
      setShowImageView(true);
    }
  };

  const handleEditClick = () => {
    setShowEditor(true);
  };

  const handleEditorSave = async (blob: Blob) => {
    await onPictureUpload(blob);
    setShowEditor(false);
  };

  const handleEditorRemove = async () => {
    await onPictureRemove();
    setShowEditor(false);
  };

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
    <>
      <SettingsCard
        title="Profile"
        description="Your personal information"
      >
        <div className="profile-header">
          <UserAvatar
            picture={profile.picture}
            name={displayName}
            email={profile.email}
            size="lg"
            showEditOverlay
            onClick={handleAvatarClick}
            onEditClick={handleEditClick}
          />
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
              <span className="profile-name profile-name-editable" onClick={handleStartEdit}>
                {displayName}
                <Pencil size={13} className="profile-name-pencil" />
              </span>
            )}
            <p className="profile-email">{profile.email}</p>
          </div>
        </div>
      </SettingsCard>

      {showEditor && (
        <ProfilePictureEditor
          currentPicture={profile.picture}
          onSave={handleEditorSave}
          onRemove={handleEditorRemove}
          onClose={() => setShowEditor(false)}
        />
      )}

      {showImageView && profile.picture && (
        <ImageViewModal
          src={profile.picture}
          onClose={() => setShowImageView(false)}
        />
      )}
    </>
  );
}
