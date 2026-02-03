"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import {
  Home,
  Layers,
  ScrollText,
  TrendingUp,
  Radio,
  KeyRound,
  Bell,
  Settings,
  CircleHelpIcon,
  PanelLeftClose,
  PanelLeft,
  Sun,
  Moon,
} from "lucide-react";
import { useSidebar } from "@/components/providers/SidebarProvider";
import { useTheme } from "@/components/providers/ThemeProvider";

const navigation = [
  { name: "Overview", href: "/", icon: Home },
  { name: "Endpoints", href: "/endpoints", icon: Layers },
  { name: "Logs", href: "/logs", icon: ScrollText },
  { name: "Analytics", href: "/analytics", icon: TrendingUp },
  { name: "Monitors", href: "/monitors", icon: Radio },
  { name: "API Keys", href: "/api-keys", icon: KeyRound },
];

const secondaryNavigation = [
  { name: "Notifications", href: "/notifications", icon: Bell },
  { name: "Settings", href: "/settings", icon: Settings },
  { name: "Help & Support", href: "/help", icon: CircleHelpIcon },
];

export default function Sidebar() {
  const pathname = usePathname();
  const { collapsed, toggleSidebar } = useSidebar();
  const { theme, toggleTheme } = useTheme();

  return (
    <aside className={`sidebar ${collapsed ? "sidebar-collapsed" : ""}`}>
      <div className="sidebar-header">
        <Link href="/" className="logo">
          {collapsed ? (
            <Image
              src="/logo.svg"
              alt="ApiLens"
              width={28}
              height={28}
              className="logo-icon-collapsed"
            />
          ) : (
            <span className="logo-text">ApiLens</span>
          )}
        </Link>
      </div>

      <nav className="sidebar-nav">
        <div className="nav-section">
          {!collapsed && <span className="nav-section-title">Main</span>}
          <ul className="nav-list">
            {navigation.map((item) => {
              const isActive = pathname === item.href;
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
              const isActive = pathname === item.href;
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
            onClick={toggleTheme}
            title={theme === "dark" ? "Light Mode" : "Dark Mode"}
          >
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            {!collapsed && <span>{theme === "dark" ? "Light Mode" : "Dark Mode"}</span>}
          </button>

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
