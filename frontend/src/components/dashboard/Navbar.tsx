"use client";

import { useAuth } from "@/components/providers/AuthProvider";
import UserAvatar from "@/components/shared/UserAvatar";
import Breadcrumbs from "./Breadcrumbs";
import { Bell, LogOut, Settings } from "lucide-react";
import { useState, useRef, useEffect } from "react";

export interface NavbarProps {
  appSlug?: string;
  projectSlug?: string;
}

export default function Navbar({ appSlug, projectSlug }: NavbarProps) {
  const { user, isLoading, logout } = useAuth();
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
        {appSlug && <Breadcrumbs appSlug={appSlug} />}
        {projectSlug && !appSlug && <Breadcrumbs projectSlug={projectSlug} />}
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
            {!isLoading && user ? (
              <UserAvatar
                picture={user.picture}
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

