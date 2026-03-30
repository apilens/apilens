"use client";

import Link from "next/link";
import { Settings, BookOpen } from "lucide-react";

export type AppSettingsTab = "general" | "setup";

interface AppSettingsSidebarProps {
  appSlug: string;
  projectSlug?: string;
  activeTab: AppSettingsTab;
}

const menuItems: { id: AppSettingsTab; label: string; icon: React.ElementType }[] = [
  { id: "general", label: "General", icon: Settings },
  { id: "setup", label: "Setup Guide", icon: BookOpen },
];

export default function AppSettingsSidebar({ appSlug, projectSlug, activeTab }: AppSettingsSidebarProps) {
  const baseUrl = projectSlug
    ? `/projects/${projectSlug}/apps/${appSlug}/settings`
    : `/apps/${appSlug}/settings`;

  return (
    <nav className="settings-sidebar">
      <ul className="settings-sidebar-menu">
        {menuItems.map((item) => (
          <li key={item.id}>
            <Link
              href={`${baseUrl}/${item.id}`}
              className={`settings-sidebar-item ${activeTab === item.id ? "active" : ""}`}
            >
              <item.icon size={16} />
              <span>{item.label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
