"use client";

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
  name?: string | null;
  email?: string | null;
  size?: "sm" | "lg";
  onClick?: () => void;
}

export default function UserAvatar({
  name,
  email,
  size = "sm",
  onClick,
}: UserAvatarProps) {
  const sizeClass = size === "lg" ? "profile-avatar-large" : "user-avatar-gradient";
  const initialsClass = size === "lg" ? "profile-avatar-initial" : "user-avatar-initials";

  return (
    <div className={sizeClass} onClick={onClick} style={onClick ? { cursor: "pointer" } : undefined}>
      <span className={initialsClass}>{getInitials(name, email)}</span>
    </div>
  );
}
