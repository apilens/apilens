"use client";

import { useState } from "react";
import { Check, X, Loader2, Pencil } from "lucide-react";
import { UserProfile } from "@/types/settings";
import SettingsCard from "./SettingsCard";
import UserAvatar from "@/components/shared/UserAvatar";
import Skeleton from "@/components/ui/Skeleton";

interface ProfileSectionProps {
  profile: UserProfile | null;
  onUpdateName: (name: string) => Promise<void>;
}

const NAME_MAX_LENGTH = 100;

export default function ProfileSection({
  profile,
  onUpdateName,
}: ProfileSectionProps) {
  const displayName = profile?.display_name || "";
  const [isEditing, setIsEditing] = useState(false);
  const [editedName, setEditedName] = useState(displayName);
  const [isSaving, setIsSaving] = useState(false);
  const [nameError, setNameError] = useState("");
  const [justSaved, setJustSaved] = useState(false);

  const handleStartEdit = () => {
    setEditedName(displayName);
    setNameError("");
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    setEditedName(displayName);
    setNameError("");
    setIsEditing(false);
  };

  const validateName = (value: string): string => {
    const trimmed = value.trim();
    if (!trimmed) return "Name can't be empty";
    if (trimmed.length > NAME_MAX_LENGTH) return `Keep it under ${NAME_MAX_LENGTH} characters`;
    return "";
  };

  const handleSave = async () => {
    const trimmed = editedName.trim();
    if (trimmed === displayName) {
      handleCancelEdit();
      return;
    }
    const err = validateName(editedName);
    if (err) {
      setNameError(err);
      return;
    }

    setIsSaving(true);
    try {
      await onUpdateName(trimmed);
      setIsEditing(false);
      setNameError("");
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2000);
    } catch {
      // Toast handled by useAccountSettings; keep edit mode open.
    } finally {
      setIsSaving(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSave();
    else if (e.key === "Escape") handleCancelEdit();
  };

  // ── Loading state ───────────────────────────────────────────────
  if (!profile) {
    return (
      <SettingsCard title="Profile" description="Your personal information">
        <div className="profile-header">
          <Skeleton variant="avatar" width={72} height={72} />
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "8px" }}>
            <Skeleton variant="line" width={160} height={20} />
            <Skeleton variant="line" width={200} height={14} />
          </div>
        </div>
      </SettingsCard>
    );
  }

  // ── Live char counter helper ────────────────────────────────────
  const overLimit = editedName.length > NAME_MAX_LENGTH;
  const showCounter = isEditing && (editedName.length > NAME_MAX_LENGTH - 20 || nameError);

  return (
    <SettingsCard title="Profile" description="Your personal information">
      <div className="profile-header">
        <UserAvatar
          name={displayName}
          email={profile.email}
          size="lg"
        />
        <div className="profile-info">
          {isEditing ? (
            <>
              <div className="profile-edit-row">
                <input
                  type="text"
                  className="profile-edit-input"
                  value={editedName}
                  onChange={(e) => {
                    setEditedName(e.target.value);
                    if (nameError) setNameError("");
                  }}
                  onKeyDown={handleKeyDown}
                  maxLength={NAME_MAX_LENGTH + 10}
                  autoFocus
                  disabled={isSaving}
                  aria-invalid={!!nameError}
                />
                <div className="profile-edit-actions">
                  <button
                    className="settings-btn settings-btn-icon settings-btn-primary"
                    onClick={handleSave}
                    disabled={isSaving || !editedName.trim() || overLimit}
                    aria-label="Save name"
                  >
                    {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                  </button>
                  <button
                    className="settings-btn settings-btn-icon settings-btn-ghost"
                    onClick={handleCancelEdit}
                    disabled={isSaving}
                    aria-label="Cancel editing"
                  >
                    <X size={14} />
                  </button>
                </div>
              </div>
              {(nameError || showCounter) && (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: "12px",
                    marginTop: "4px",
                    fontSize: "12px",
                    lineHeight: 1.5,
                  }}
                >
                  <span style={{ color: nameError ? "var(--danger, #dc2626)" : "var(--text-secondary)" }}>
                    {nameError}
                  </span>
                  {showCounter && (
                    <span
                      style={{
                        color: overLimit ? "var(--danger, #dc2626)" : "var(--text-secondary)",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {editedName.length} / {NAME_MAX_LENGTH}
                    </span>
                  )}
                </div>
              )}
            </>
          ) : (
            <span
              className="profile-name profile-name-editable"
              onClick={handleStartEdit}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handleStartEdit();
                }
              }}
            >
              {displayName}
              <Pencil size={13} className="profile-name-pencil" aria-hidden="true" />
              {justSaved && (
                <span
                  style={{
                    marginLeft: "8px",
                    fontSize: "12px",
                    color: "var(--success, #16a34a)",
                    fontWeight: 500,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                    animation: "fade-in 0.15s ease",
                  }}
                  aria-live="polite"
                >
                  <Check size={12} />
                  Saved
                </span>
              )}
            </span>
          )}
          <p className="profile-email">{profile.email}</p>
        </div>
      </div>
    </SettingsCard>
  );
}
