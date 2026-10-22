import { cn } from "@/lib/utils";

/** Person avatar: initials on a neutral disc. Organizations and projects use TenantAvatar (square, colored). */
export function Avatar({ name, size = "md", className }: { name: string; size?: "sm" | "md"; className?: string }) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full bg-accent font-medium text-muted-foreground shadow-control",
        size === "sm" ? "size-5 text-2xs" : "size-6 text-2xs",
        className,
      )}
    >
      {initials}
    </span>
  );
}
