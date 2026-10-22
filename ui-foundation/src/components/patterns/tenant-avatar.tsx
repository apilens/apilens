import { cn } from "@/lib/utils";

// Each project gets a stable, distinct mark so users can tell tenants apart
// at a glance, the main safeguard against acting in the wrong project.
const SLOTS = [
  "bg-chart-1/20 text-chart-1",
  "bg-chart-2/20 text-chart-2",
  "bg-chart-3/20 text-chart-3",
  "bg-chart-4/20 text-chart-4",
  "bg-chart-5/20 text-chart-5",
  "bg-chart-7/20 text-chart-7",
] as const;

function slotFor(slug: string) {
  let h = 0;
  for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return SLOTS[h % SLOTS.length];
}

export function TenantAvatar({ name, slug, size = "md" }: { name: string; slug: string; size?: "sm" | "md" }) {
  const initials = name
    .split(/[\s-]+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md font-semibold",
        size === "sm" ? "size-5 text-2xs" : "size-6 text-2xs",
        slotFor(slug),
      )}
    >
      {initials}
    </span>
  );
}
