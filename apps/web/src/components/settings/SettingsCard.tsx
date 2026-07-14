"use client";

import { ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/reui/card";

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
    <Card
      className={cn(
        "gap-0 rounded-xl py-0",
        variant === "danger" && "border-destructive/30",
      )}
    >
      <CardHeader className="border-b border-border px-6 py-5 [.border-b]:pb-5">
        <CardTitle className="text-base font-semibold">{title}</CardTitle>
        {description && (
          <CardDescription className="text-[13px]">{description}</CardDescription>
        )}
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent className="px-6 py-5">{children}</CardContent>
    </Card>
  );
}
