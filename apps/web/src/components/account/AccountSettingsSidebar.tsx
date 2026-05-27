"use client";

import Link from "next/link";
import { Settings, User } from "lucide-react";

export type AccountSettingsTab = "general" | "account";

interface AccountSettingsSidebarProps {
  activeTab: AccountSettingsTab;
}

const menuItems: { id: AccountSettingsTab; label: string; icon: React.ElementType }[] = [
  { id: "general", label: "General", icon: Settings },
  { id: "account", label: "Account", icon: User },
];

export default function AccountSettingsSidebar({ activeTab }: AccountSettingsSidebarProps) {
  return (
    <nav className="settings-sidebar">
      <ul className="settings-sidebar-menu">
        {menuItems.map((item) => (
          <li key={item.id}>
            <Link
              href={`/account/${item.id}`}
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
