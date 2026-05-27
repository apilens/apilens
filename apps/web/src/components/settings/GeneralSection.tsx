"use client";

import { Moon, Sun, Monitor } from "lucide-react";
import { useTheme } from "@/components/providers/ThemeProvider";
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
        <div className="theme-options">
          {themeOptions.map((option) => (
            <button
              key={option.id}
              className={`theme-option ${theme === option.id ? "active" : ""}`}
              onClick={() => setTheme(option.id)}
            >
              <div className="theme-option-icon">
                <option.icon size={20} />
              </div>
              <span className="theme-option-label">{option.label}</span>
            </button>
          ))}
        </div>
      </SettingsCard>
    </div>
  );
}
