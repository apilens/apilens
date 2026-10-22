import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// tailwind-merge must know our custom scales, or it drops e.g. `shadow-control`
// when a caller passes `shadow-overlay`, and treats `text-2xs` as a color.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["2xs", "xs", "sm", "base", "lg", "xl", "2xl", "3xl"],
      shadow: ["panel", "control", "control-primary", "control-destructive", "overlay"],
      radius: ["sm", "md", "lg", "xl"],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
