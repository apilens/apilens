"use client";

import { useUser } from "@auth0/nextjs-auth0/client";
import { Search, Bell, LogOut, Settings } from "lucide-react";
import { useState, useRef, useEffect } from "react";

export default function Navbar() {
  const { user } = useUser();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [imgError, setImgError] = useState(false);
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
              {user?.picture && !imgError ? (
                <img
                  src={user.picture}
                  alt={user.name || "User"}
                  onError={() => setImgError(true)}
                />
              ) : null}
            </div>
          </button>

          {dropdownOpen && (
            <div className="dropdown-menu">
              <div className="dropdown-header">
                <p className="dropdown-user-name">{user?.name}</p>
                <p className="dropdown-user-email">{user?.email}</p>
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
