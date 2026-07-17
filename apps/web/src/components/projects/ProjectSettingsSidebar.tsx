"use client";

import Link from "next/link";
import { Settings, Key, Users, GitBranch } from "lucide-react";

export type ProjectSettingsTab = "general" | "api-keys" | "members" | "integrations";

interface ProjectSettingsSidebarProps {
  projectSlug: string;
  activeTab: ProjectSettingsTab;
}

const menuItems: { id: ProjectSettingsTab; label: string; icon: React.ElementType }[] = [
  { id: "general", label: "General", icon: Settings },
  { id: "members", label: "Members", icon: Users },
  { id: "api-keys", label: "API Keys", icon: Key },
  { id: "integrations", label: "Integrations", icon: GitBranch },
];

export default function ProjectSettingsSidebar({ projectSlug, activeTab }: ProjectSettingsSidebarProps) {
  return (
    <nav className="settings-sidebar">
      <ul className="settings-sidebar-menu">
        {menuItems.map((item) => (
          <li key={item.id}>
            <Link
              href={`/projects/${projectSlug}/settings/${item.id}`}
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
