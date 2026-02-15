"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { useState, useEffect, useRef } from "react";
import {
  Layers,
  ScrollText,
  TrendingUp,
  Radio,
  Settings,
  Bell,
  CircleHelpIcon,
  PanelLeftClose,
  PanelLeft,
  ChevronsUpDown,
  Plus,
  Check,
} from "lucide-react";
import { useSidebar } from "@/components/providers/SidebarProvider";
import { useApp } from "@/components/providers/AppProvider";

interface AppListItem {
  id: string;
  name: string;
  slug: string;
  icon_url: string;
}

interface SidebarProps {
  appSlug?: string;
}

export default function Sidebar({ appSlug }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { collapsed, toggleSidebar } = useSidebar();
  const { app: currentApp } = useApp();

  const [apps, setApps] = useState<AppListItem[]>([]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const hasApp = Boolean(appSlug);
  const basePath = hasApp ? `/apps/${appSlug}` : "/apps";

  const getCurrentSection = () => {
    const parts = pathname.split("/").filter(Boolean);
    return parts.slice(2).join("/") || "endpoints";
  };

  useEffect(() => {
    async function fetchApps() {
      try {
        const res = await fetch("/api/apps");
        if (res.ok) {
          const data = await res.json();
          setApps(data.apps || []);
        }
      } catch {
        // ignore
      }
    }
    fetchApps();
  }, []);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    }
    if (dropdownOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [dropdownOpen]);

  const handleSwitchApp = (slug: string) => {
    setDropdownOpen(false);
    const section = getCurrentSection();
    router.push(`/apps/${slug}/${section}`);
  };

  const navigation = hasApp
    ? [
      { name: "Endpoints", href: `${basePath}/endpoints`, icon: Layers },
      { name: "Logs", href: `${basePath}/logs`, icon: ScrollText },
      { name: "Analytics", href: `${basePath}/analytics`, icon: TrendingUp },
      { name: "Monitors", href: `${basePath}/monitors`, icon: Radio },
      { name: "Settings", href: `${basePath}/settings/general`, icon: Settings },
    ]
    : [
      { name: "Apps", href: "/apps", icon: Layers },
      { name: "Create App", href: "/apps/new", icon: Plus },
      { name: "Account", href: "/settings/general", icon: Settings },
    ];

  const secondaryNavigation = [
    { name: "Notifications", href: "/notifications", icon: Bell },
    { name: "Help & Support", href: "/help", icon: CircleHelpIcon },
  ];

  const displayName = currentApp?.name || appSlug || "Select app";
  const currentAvatar = (displayName.charAt(0) || "A").toUpperCase().slice(0, 2);

  return (
    <aside className={`sidebar ${collapsed ? "sidebar-collapsed" : ""}`}>
      <div className="sidebar-header">
        <Link href="/apps" className="logo" title="Back to Apps">
          {collapsed ? (
            <Image
              src="/logo.svg"
              alt="ApiLens"
              width={28}
              height={28}
              className="logo-icon-collapsed"
            />
          ) : (
            <span className="logo-text">API Lens</span>
          )}
        </Link>
      </div>

      {/* App Switcher */}
      <div className="app-switcher" ref={dropdownRef}>
        <button
          className="app-switcher-trigger"
          onClick={() => setDropdownOpen((prev) => !prev)}
          title={collapsed ? displayName : undefined}
        >
          <span className="app-switcher-avatar">
            {currentApp?.icon_url ? (
              <img src={currentApp.icon_url} alt={displayName} className="app-switcher-avatar-image" />
            ) : (
              currentAvatar
            )}
          </span>
          {!collapsed && (
            <>
              <span className="app-switcher-label">{displayName}</span>
              <ChevronsUpDown size={14} className="app-switcher-icon" />
            </>
          )}
        </button>

        {dropdownOpen && (
          <div className="app-switcher-dropdown">
            <div className="app-switcher-section-label">Apps</div>
            <div className="app-switcher-list">
              {apps.map((app) => {
                const isActive = app.slug === appSlug;
                return (
                  <button
                    key={app.id}
                    className={`app-switcher-option ${isActive ? "app-switcher-option-active" : ""}`}
                    onClick={() => handleSwitchApp(app.slug)}
                  >
                    <span className="app-switcher-option-avatar">
                      {app.icon_url ? (
                        <img src={app.icon_url} alt={app.name} className="app-switcher-option-avatar-image" />
                      ) : (
                        (app.name.charAt(0) || "A").toUpperCase().slice(0, 2)
                      )}
                    </span>
                    <span className="app-switcher-option-name">{app.name}</span>
                    {isActive && <Check size={14} className="app-switcher-check" />}
                  </button>
                );
              })}
            </div>
            <div className="app-switcher-footer">
              <Link
                href="/apps/new"
                className="app-switcher-action"
                onClick={() => setDropdownOpen(false)}
              >
                <Plus size={14} />
                <span>Create app</span>
              </Link>
            </div>
          </div>
        )}
      </div>

      <nav className="sidebar-nav">
        <div className="nav-section">
          {!collapsed && <span className="nav-section-title">Main</span>}
          <ul className="nav-list">
            {navigation.map((item) => {
              const isActive = hasApp
                ? (
                  item.name === "Settings"
                    ? pathname.startsWith(`${basePath}/settings`)
                    : pathname === item.href || pathname.startsWith(item.href + "/")
                )
                : pathname === item.href || pathname.startsWith(item.href + "/");
              return (
                <li key={item.name}>
                  <Link
                    href={item.href}
                    className={`nav-item ${isActive ? "nav-item-active" : ""}`}
                    title={collapsed ? item.name : undefined}
                  >
                    <item.icon size={16} className="nav-icon" />
                    {!collapsed && <span>{item.name}</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="nav-section">
          {!collapsed && <span className="nav-section-title">Support</span>}
          <ul className="nav-list">
            {secondaryNavigation.map((item) => {
              const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
              return (
                <li key={item.name}>
                  <Link
                    href={item.href}
                    className={`nav-item ${isActive ? "nav-item-active" : ""}`}
                    title={collapsed ? item.name : undefined}
                  >
                    <item.icon size={16} className="nav-icon" />
                    {!collapsed && <span>{item.name}</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      </nav>

      <div className="sidebar-footer">
        <div className="sidebar-actions">
          <button
            className="sidebar-action-btn"
            onClick={toggleSidebar}
            title={collapsed ? "Expand Sidebar" : "Collapse Sidebar"}
          >
            {collapsed ? <PanelLeft size={16} /> : <PanelLeftClose size={16} />}
            {!collapsed && <span>Collapse</span>}
          </button>
        </div>
      </div>
    </aside>
  );
}
