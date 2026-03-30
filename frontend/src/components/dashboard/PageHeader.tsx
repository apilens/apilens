"use client";

import { ArrowLeft } from "lucide-react";
import { useApp } from "@/components/providers/AppProvider";

interface PageHeaderProps {
  title: string;
  description?: string;
  onBack?: () => void;
  backLabel?: string;
}

export default function PageHeader({ title, description, onBack, backLabel = "Back" }: PageHeaderProps) {
  const { app } = useApp();

  return (
    <div className="page-header">
      {onBack && (
        <button
          onClick={onBack}
          className="page-header-back"
          aria-label={backLabel}
        >
          <ArrowLeft size={16} />
          <span>{backLabel}</span>
        </button>
      )}
      {app && <span className="page-header-app">{app.name}</span>}
      <h1 className="page-header-title">{title}</h1>
      {description && <p className="page-header-desc">{description}</p>}
    </div>
  );
}
