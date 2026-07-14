"use client";

import { ArrowLeft } from "lucide-react";
import { useApp } from "@/components/providers/AppProvider";
import { Button } from "@/components/reui/button";

interface PageHeaderProps {
  title: string;
  description?: string;
  onBack?: () => void;
  backLabel?: string;
}

export default function PageHeader({ title, description, onBack, backLabel = "Back" }: PageHeaderProps) {
  const { app } = useApp();

  return (
    // `.page-header` stays: it is a layout-contract class (`.settings-page >
    // .page-header` gates the divider/spacing on settings surfaces).
    <div className="page-header">
      {onBack && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          aria-label={backLabel}
          className="-ml-2 mb-2 h-7 gap-1 px-2 text-[13px] font-medium text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={16} />
          <span>{backLabel}</span>
        </Button>
      )}
      {app && (
        <span className="mb-1 block text-xs font-medium tracking-wide text-muted-foreground">
          {app.name}
        </span>
      )}
      <h1 className="m-0 text-[22px] font-bold leading-snug text-foreground">{title}</h1>
      {description && <p className="mt-1.5 text-sm text-muted-foreground">{description}</p>}
    </div>
  );
}
