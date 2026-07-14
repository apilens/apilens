"use client";

import Link from "next/link";
import { Settings, Key, Users } from "lucide-react";
import { cn } from "@/lib/utils";

export type ProjectSettingsTab = "general" | "api-keys" | "members";

interface ProjectSettingsSidebarProps {
  projectSlug: string;
  activeTab: ProjectSettingsTab;
}

const menuItems: { id: ProjectSettingsTab; label: string; icon: React.ElementType }[] = [
  { id: "general", label: "General", icon: Settings },
  { id: "members", label: "Members", icon: Users },
  { id: "api-keys", label: "API Keys", icon: Key },
];

export default function ProjectSettingsSidebar({ projectSlug, activeTab }: ProjectSettingsSidebarProps) {
  return (
    <nav className="settings-sidebar">
      <ul className="settings-sidebar-menu">
        {menuItems.map((item) => {
          const isActive = activeTab === item.id;
          return (
            <li key={item.id}>
              <Link
                href={`/projects/${projectSlug}/settings/${item.id}`}
                className={cn(
                  "flex w-full items-center gap-3 whitespace-nowrap rounded-lg px-3.5 py-2.5 text-sm font-medium text-muted-foreground transition-colors",
                  "hover:bg-accent hover:text-foreground",
                  isActive && "bg-primary/10 font-semibold text-foreground",
                )}
              >
                <item.icon
                  size={16}
                  className={cn("shrink-0 opacity-70", isActive && "text-primary opacity-100")}
                />
                <span>{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
