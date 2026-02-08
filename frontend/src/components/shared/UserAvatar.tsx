"use client";

import { Camera } from "lucide-react";

function getInitials(name?: string | null, email?: string | null): string {
  if (name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) {
      return parts[0].charAt(0).toUpperCase();
    }
    return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
  }
  if (email) {
    return email.charAt(0).toUpperCase();
  }
  return "U";
}

interface UserAvatarProps {
  picture?: string;
  name?: string | null;
  email?: string | null;
  size?: "sm" | "lg";
  onClick?: () => void;
  onEditClick?: () => void;
  showEditOverlay?: boolean;
}

export default function UserAvatar({
  picture,
  name,
  email,
  size = "sm",
  onClick,
  onEditClick,
  showEditOverlay = false,
}: UserAvatarProps) {
  const sizeClass = size === "lg" ? "profile-avatar-large" : "user-avatar-gradient";
  const initialsClass = size === "lg" ? "profile-avatar-initial" : "user-avatar-initials";

  if (showEditOverlay) {
    return (
      <div className="profile-avatar-wrapper">
        <div
          className={sizeClass}
          onClick={picture ? onClick : onEditClick}
          style={{ cursor: "pointer" }}
        >
          {picture ? (
            <img src={picture} alt="Profile" />
          ) : (
            <span className={initialsClass}>{getInitials(name, email)}</span>
          )}
        </div>
        <div className="profile-avatar-edit" onClick={onEditClick}>
          <Camera size={20} className="profile-avatar-edit-icon" />
        </div>
      </div>
    );
  }

  return (
    <div className={sizeClass} onClick={onClick} style={onClick ? { cursor: "pointer" } : undefined}>
      {picture ? (
        <img src={picture} alt="Profile" />
      ) : (
        <span className={initialsClass}>{getInitials(name, email)}</span>
      )}
    </div>
  );
}
