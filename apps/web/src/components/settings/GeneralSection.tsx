"use client";

import { Moon, Sun, Monitor } from "lucide-react";
import { useTheme } from "@/components/providers/ThemeProvider";
import { cn } from "@/lib/utils";
import SettingsCard from "./SettingsCard";

type ThemeOption = "light" | "dark" | "system";

const themeOptions: { id: ThemeOption; label: string; icon: React.ElementType }[] = [
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
  { id: "system", label: "System", icon: Monitor },
];

export default function GeneralSection() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="settings-section-content">
      <SettingsCard
        title="Appearance"
        description="Customize how the app looks on your device"
      >
        <div className="flex gap-3">
          {themeOptions.map((option) => {
            const isActive = theme === option.id;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => setTheme(option.id)}
                aria-pressed={isActive}
                className={cn(
                  "flex flex-1 flex-col items-center gap-2 rounded-lg border border-border bg-background px-4 py-4 text-[13px] font-medium text-muted-foreground transition-colors",
                  "hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  isActive && "border-primary bg-primary/5 text-foreground",
                )}
              >
                <span
                  className={cn(
                    "flex size-9 items-center justify-center rounded-md bg-muted text-muted-foreground",
                    isActive && "bg-primary/10 text-primary",
                  )}
                >
                  <option.icon size={20} />
                </span>
                <span>{option.label}</span>
              </button>
            );
          })}
        </div>
      </SettingsCard>
    </div>
  );
}
