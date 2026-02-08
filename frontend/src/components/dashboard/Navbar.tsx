"use client";

import { useAuth } from "@/components/providers/AuthProvider";
import UserAvatar from "@/components/shared/UserAvatar";
import { Search, Bell, LogOut, Settings, User } from "lucide-react";
import { useState, useRef, useEffect } from "react";

export default function Navbar() {
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
              <a href="/settings" className="dropdown-item">
                <Settings size={14} />
                <span>Settings</span>
              </a>
              <a href="/settings/account" className="dropdown-item">
                <User size={14} />
                <span>Accounts</span>
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
