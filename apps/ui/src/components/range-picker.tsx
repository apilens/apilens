import type { MouseEvent } from "react";
import "./range-picker.css";

/** Every range a page can offer, in order, with its words for the tooltip. */
export const RANGE_WORDS = { "1h": "1 hour", "6h": "6 hours", "24h": "24 hours", "7d": "7 days", "30d": "30 days" } as const;
export type PickerRange = keyof typeof RANGE_WORDS;

/**
 * The shared time range picker (#992): one segmented control of links, 1h / 6h / 24h / 7d, plus
 * 30d on pages whose data goes back that far. `options` are the ranges the page supports, `value`
 * the one in the URL and `href` the page URL for a range. `onNavigate` lets a Client Component
 * take over the click (a soft navigation); without it the links are plain.
 */
export function RangePicker<R extends PickerRange>({
  options,
  value,
  href,
  onNavigate,
  label = "Time range",
}: {
  options: readonly R[];
  value: R;
  href: (r: R) => string;
  onNavigate?: (e: MouseEvent<HTMLAnchorElement>, href: string) => void;
  label?: string;
}) {
  return (
    <nav className="rp" aria-label={label}>
      {options.map((r) => {
        const to = href(r);
        return (
          <a key={r} href={to} onClick={onNavigate ? (e) => onNavigate(e, to) : undefined} aria-current={value === r ? "page" : undefined} title={`Last ${RANGE_WORDS[r]}`}>
            {r}
          </a>
        );
      })}
    </nav>
  );
}
