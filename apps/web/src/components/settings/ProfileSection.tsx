"use client";

import { useState } from "react";
import { Check, X, Loader2, Pencil } from "lucide-react";
import { UserProfile } from "@/types/settings";
import SettingsCard from "./SettingsCard";
import UserAvatar from "@/components/shared/UserAvatar";
import { cn } from "@/lib/utils";
import { Button } from "@/components/reui/button";
import { Input } from "@/components/reui/input";
import { Skeleton } from "@/components/reui/skeleton";

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
        <div className="flex items-center gap-5">
          <Skeleton className="size-[72px] shrink-0 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-3.5 w-50" />
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
      <div className="flex items-center gap-5">
        <UserAvatar
          name={displayName}
          email={profile.email}
          size="lg"
        />
        <div className="min-w-0 flex-1">
          {isEditing ? (
            <>
              <div className="flex items-center gap-2">
                <Input
                  type="text"
                  className="h-8 max-w-xs text-[13px]"
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
                <div className="flex items-center gap-1">
                  <Button
                    size="icon-sm"
                    onClick={handleSave}
                    disabled={isSaving || !editedName.trim() || overLimit}
                    aria-label="Save name"
                  >
                    {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={handleCancelEdit}
                    disabled={isSaving}
                    aria-label="Cancel editing"
                  >
                    <X size={14} />
                  </Button>
                </div>
              </div>
              {(nameError || showCounter) && (
                <div className="mt-1 flex justify-between gap-3 text-xs leading-normal">
                  <span className={nameError ? "text-destructive" : "text-muted-foreground"}>
                    {nameError}
                  </span>
                  {showCounter && (
                    <span
                      className={cn(
                        "tabular-nums",
                        overLimit ? "text-destructive" : "text-muted-foreground",
                      )}
                    >
                      {editedName.length} / {NAME_MAX_LENGTH}
                    </span>
                  )}
                </div>
              )}
            </>
          ) : (
            <span
              className="group inline-flex cursor-pointer items-center gap-1.5 rounded-md text-[15px] font-semibold text-foreground outline-none hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50"
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
              <Pencil
                size={13}
                className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                aria-hidden="true"
              />
              {justSaved && (
                <span
                  className="ml-2 inline-flex items-center gap-1 text-xs font-medium text-success"
                  aria-live="polite"
                >
                  <Check size={12} />
                  Saved
                </span>
              )}
            </span>
          )}
          <p className="mt-0.5 text-[13px] text-muted-foreground">{profile.email}</p>
        </div>
      </div>
    </SettingsCard>
  );
}
