import { cn } from "@/lib/utils";

/** Pending indicator for in-flight actions. Loading *content* uses <Skeleton/>. */
export function Spinner({ className, label = "Loading" }: { className?: string; label?: string }) {
  return (
    <svg
      role="status"
      aria-label={label}
      viewBox="0 0 16 16"
      fill="none"
      className={cn("size-4 animate-spin motion-reduce:animate-none", className)}
    >
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.5" />
      <path d="M14.25 8A6.25 6.25 0 0 0 8 1.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
