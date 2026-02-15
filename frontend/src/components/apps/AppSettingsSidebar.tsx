"use client";

import Link from "next/link";
import { Settings, Key } from "lucide-react";

export type AppSettingsTab = "general" | "api-keys";

interface AppSettingsSidebarProps {
  appSlug: string;
  activeTab: AppSettingsTab;
}

const menuItems: { id: AppSettingsTab; label: string; icon: React.ElementType }[] = [
  { id: "general", label: "General", icon: Settings },
  { id: "api-keys", label: "API Keys", icon: Key },
];

export default function AppSettingsSidebar({ appSlug, activeTab }: AppSettingsSidebarProps) {
  return (
    <nav className="settings-sidebar">
      <ul className="settings-sidebar-menu">
        {menuItems.map((item) => (
          <li key={item.id}>
            <Link
              href={`/apps/${appSlug}/settings/${item.id}`}
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
