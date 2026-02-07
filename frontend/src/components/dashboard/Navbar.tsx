"use client";

import { useUser } from "@auth0/nextjs-auth0/client";
import { Search, Bell, LogOut, Settings } from "lucide-react";
import { useState, useRef, useEffect, useCallback } from "react";

// Validate if picture is a valid displayable image
// Only base64 data URLs are valid (user-uploaded pictures)
function isValidPictureUrl(url: string | undefined): boolean {
  if (!url || typeof url !== 'string' || url.length === 0) {
    return false;
  }
  return url.startsWith('data:image/');
}

// Get initials from name (first + last name initials)
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

interface UserProfile {
  name: string;
  email: string;
  picture?: string;
}

export default function Navbar() {
  const { user, isLoading } = useUser();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [imgError, setImgError] = useState(false);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Fetch normalized profile from API
  const fetchProfile = useCallback(async () => {
    try {
      const response = await fetch("/api/account/profile");
      if (response.ok) {
        const data = await response.json();
        setProfile(data.profile);
      }
    } catch (error) {
      console.error("Error fetching profile:", error);
    }
  }, []);

  useEffect(() => {
    if (!isLoading && user) {
      fetchProfile();
    }
  }, [isLoading, user, fetchProfile]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Reset image error when profile picture changes
  useEffect(() => {
    setImgError(false);
  }, [profile?.picture]);

  // Only use normalized profile data - don't fall back to session user (which has social provider data)
  const isProfileLoaded = profile !== null;
  const displayName = profile?.name || '';
  const displayEmail = profile?.email || user?.email || '';
  const displayPicture = profile?.picture;
  const hasValidPicture = isValidPictureUrl(displayPicture);

  return (
    <header className="navbar">
      <div className="navbar-left">
        <div className="search-container">
          <Search size={16} className="search-icon" />
          <input
            type="text"
            placeholder="Search endpoints, logs..."
            className="search-input"
          />
          <kbd className="search-kbd">⌘K</kbd>
        </div>
      </div>

      <div className="navbar-right">
        <button className="navbar-icon-btn">
          <Bell size={18} />
          <span className="notification-dot" />
        </button>

        <div className="user-menu" ref={dropdownRef}>
          <button
            className="user-menu-btn"
            onClick={() => setDropdownOpen(!dropdownOpen)}
          >
            <div className="user-avatar-gradient">
              {/* Picture/logo display commented out — initials only */}
              {/* {hasValidPicture && !imgError ? (
                <img
                  src={displayPicture}
                  alt={displayName || "User"}
                  onError={() => setImgError(true)}
                />
              ) : isProfileLoaded ? (
                <span className="user-avatar-initials">
                  {getInitials(displayName, displayEmail)}
                </span>
              ) : null} */}
              {isProfileLoaded ? (
                <span className="user-avatar-initials">
                  {getInitials(displayName, displayEmail)}
                </span>
              ) : null}
            </div>
          </button>

          {dropdownOpen && (
            <div className="dropdown-menu">
              <div className="dropdown-header">
                <p className="dropdown-user-name">{displayName || displayEmail.split('@')[0]}</p>
                <p className="dropdown-user-email">{displayEmail}</p>
              </div>
              <div className="dropdown-divider" />
              <a href="/settings" className="dropdown-item">
                <Settings size={14} />
                <span>Settings</span>
              </a>
              <div className="dropdown-divider" />
              <a href="/auth/logout" className="dropdown-item dropdown-item-danger">
                <LogOut size={14} />
                <span>Logout</span>
              </a>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
