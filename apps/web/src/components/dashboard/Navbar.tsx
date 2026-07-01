"use client";

import { useAuth } from "@/components/providers/AuthProvider";
import { useSpotlight } from "@/components/providers/SpotlightProvider";
import UserAvatar from "@/components/shared/UserAvatar";
import Breadcrumbs from "./Breadcrumbs";
import NotificationsBell from "./NotificationsBell";
import { LogOut, Search, Settings } from "lucide-react";
import { useState, useRef, useEffect } from "react";

export interface NavbarProps {
  projectSlug?: string;
}

export default function Navbar({ projectSlug }: NavbarProps) {
  const { user, isLoading, logout } = useAuth();
  const { openSpotlight } = useSpotlight();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const displayName = user?.display_name || "";
  const displayEmail = user?.email || "";

  return (
    <header className="navbar">
      <div className="navbar-left">
        {projectSlug && <Breadcrumbs projectSlug={projectSlug} />}
      </div>

      <div className="navbar-right">
        <button type="button" className="ap-navbar-search" onClick={openSpotlight} aria-label="Open Spotlight search">
          <Search size={15} />
          <span className="ap-navbar-search-label">Search…</span>
          <span className="ap-kbd">⌘K</span>
        </button>

        <NotificationsBell />

        <div className="user-menu" ref={dropdownRef}>
          <button
            className="user-menu-btn"
            onClick={() => setDropdownOpen(!dropdownOpen)}
          >
            {!isLoading && user ? (
              <UserAvatar
                name={displayName}
                email={displayEmail}
                size="sm"
              />
            ) : (
              <div className="user-avatar-gradient" />
            )}
          </button>

          {dropdownOpen && (
            <div className="dropdown-menu">
              <div className="dropdown-header">
                <p className="dropdown-user-name">{displayName || displayEmail.split("@")[0]}</p>
                <p className="dropdown-user-email">{displayEmail}</p>
              </div>
              <div className="dropdown-divider" />
              <a href="/account" className="dropdown-item">
                <Settings size={14} />
                <span>Account Settings</span>
              </a>
              <div className="dropdown-divider" />
              <button
                className="dropdown-item dropdown-item-danger"
                onClick={() => {
                  setDropdownOpen(false);
                  logout();
                }}
              >
                <LogOut size={14} />
                <span>Logout</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

