/** Join class names. No merging: components avoid conflicting utilities. */
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}
