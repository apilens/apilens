"use client";

import { ReactNode } from "react";

interface SettingsCardProps {
  title: string;
  description?: string;
  children: ReactNode;
  variant?: "default" | "danger";
  action?: ReactNode;
}

export default function SettingsCard({
  title,
  description,
  children,
  variant = "default",
  action,
}: SettingsCardProps) {
  return (
    <div className={`settings-card ${variant === "danger" ? "settings-card-danger" : ""}`}>
      <div className="settings-card-header">
        <div className="settings-card-header-text">
          <h2 className="settings-card-title">{title}</h2>
          {description && <p className="settings-card-description">{description}</p>}
        </div>
        {action && <div className="settings-card-action">{action}</div>}
      </div>
      <div className="settings-card-content">{children}</div>
    </div>
  );
}
