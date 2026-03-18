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
  Users,
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

interface ProjectListItem {
  id: string;
  name: string;
  slug: string;
}

interface SidebarProps {
  appSlug?: string;
}

export default function Sidebar({ appSlug }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const { collapsed, toggleSidebar } = useSidebar();
  const { app: currentApp } = useApp();

  const parts = pathname.split("/").filter(Boolean);
  const inProject = parts[0] === "projects" && parts[1];
  const projectSlug = inProject ? parts[1] : "";
  const currentSection = parts.slice(inProject ? 2 : 1).join("/") || "endpoints";

  const [apps, setApps] = useState<AppListItem[]>([]);
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
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
    async function fetchProjects() {
      try {
        const res = await fetch("/api/projects");
        if (res.ok) {
          const data = await res.json();
          setProjects(data.projects || []);
        }
      } catch {
        // ignore
      }
    }
    fetchApps();
    fetchProjects();
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

  const handleSwitchProject = (slug: string) => {
    setDropdownOpen(false);
    router.push(`/projects/${slug}`);
  };

  const navigation = inProject
    ? [
      { name: "Overview", href: `/projects/${projectSlug}`, icon: Layers },
      { name: "Apps", href: `/projects/${projectSlug}/apps`, icon: ScrollText },
      { name: "Endpoints", href: `/projects/${projectSlug}/endpoints`, icon: TrendingUp },
      { name: "Settings", href: `/projects/${projectSlug}/settings`, icon: Settings },
    ]
    : hasApp
      ? [
        { name: "Endpoints", href: `${basePath}/endpoints`, icon: Layers },
        { name: "Analytics", href: `${basePath}/analytics`, icon: TrendingUp },
        { name: "Consumers", href: `${basePath}/consumers`, icon: Users },
        { name: "Monitors", href: `${basePath}/monitors`, icon: Radio },
        { name: "Settings", href: `${basePath}/settings/general`, icon: Settings },
      ]
      : [
        { name: "Projects", href: "/projects", icon: Layers },
        { name: "Create Project", href: "/projects/new", icon: Plus },
        { name: "Account", href: "/settings/general", icon: Settings },
      ];

  const secondaryNavigation = [
    { name: "Notifications", href: "/notifications", icon: Bell },
    { name: "Help & Support", href: "/help", icon: CircleHelpIcon },
  ];

  const currentProject = projects.find((p) => p.slug === projectSlug);
  const displayName = currentProject?.name || (inProject ? projectSlug : "Select project");
  const currentAvatar = (displayName?.charAt(0) || "P").toUpperCase().slice(0, 2);

  return (
    <aside className={`sidebar ${collapsed ? "sidebar-collapsed" : ""}`}>
      <div className="sidebar-header">
        <Link href="/projects" className="logo" title="Back to Projects">
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

      {/* Project Switcher */}
      <div className="app-switcher" ref={dropdownRef}>
        <button
          className="app-switcher-trigger"
          onClick={() => setDropdownOpen((prev) => !prev)}
          title={collapsed ? displayName : undefined}
        >
          <span className="app-switcher-avatar">
            {currentAvatar}
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
            <div className="app-switcher-section-label">Projects</div>
            <div className="app-switcher-list">
              {projects.map((project) => {
                const isActive = project.slug === projectSlug;
                return (
                  <button
                    key={project.id}
                    className={`app-switcher-option ${isActive ? "app-switcher-option-active" : ""}`}
                    onClick={() => handleSwitchProject(project.slug)}
                  >
                    <span className="app-switcher-option-avatar">
                      {(project.name.charAt(0) || "P").toUpperCase().slice(0, 2)}
                    </span>
                    <span className="app-switcher-option-name">{project.name}</span>
                    {isActive && <Check size={14} className="app-switcher-check" />}
                  </button>
                );
              })}
            </div>
            <div className="app-switcher-footer">
              <Link
                href="/projects"
                className="app-switcher-action"
                onClick={() => setDropdownOpen(false)}
              >
                <Layers size={14} />
                <span>View all projects</span>
              </Link>
              <Link
                href="/projects/new"
                className="app-switcher-action"
                onClick={() => setDropdownOpen(false)}
              >
                <Plus size={14} />
                <span>Create project</span>
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
              let isActive = false;
              if (inProject) {
                // For project navigation, use exact match for Overview
                if (item.name === "Overview") {
                  isActive = pathname === item.href;
                } else {
                  isActive = pathname === item.href || pathname.startsWith(item.href + "/");
                }
              } else if (hasApp) {
                // For app navigation
                isActive = item.name === "Settings"
                  ? pathname.startsWith(`${basePath}/settings`)
                  : pathname === item.href || pathname.startsWith(item.href + "/");
              } else {
                // For other navigation
                isActive = pathname === item.href || pathname.startsWith(item.href + "/");
              }
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
