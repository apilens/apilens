import { cn } from "@/lib/utils";

export type Status = "success" | "warning" | "danger" | "info" | "neutral";

const tone: Record<Status, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
  neutral: "bg-subtle-foreground",
};

/** Status is never color alone: the dot always ships with its label. */
export function StatusDot({ status, label, className }: { status: Status; label: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm text-foreground", className)}>
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", tone[status])} />
      {label}
    </span>
  );
}
