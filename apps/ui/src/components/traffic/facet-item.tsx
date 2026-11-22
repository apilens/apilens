import Link from "next/link";
import type { ReactNode } from "react";
import { compactCount } from "@/lib/explore-query";
import { Icon } from "../icons";

/**
 * One sidebar value (Explore's facet row look): a link with Explore's 16px box, ticked for the
 * value in use, its requests, and the hover "Only" that keeps it alone. Shared by the server
 * sidebar and the searchable Status list.
 */
export function Item({
  on,
  href,
  only,
  label,
  count,
  mono = false,
  body,
  partial = false,
  unit = "requests",
}: {
  on: boolean;
  /** Some of what the row stands for is in (a level with only some of its codes): Explore's dash. */
  partial?: boolean;
  /** What the count counts, for its tooltip. */
  unit?: string;
  href: string;
  /** Keeps this value alone (Explore's hover Only). */
  only: string;
  label: string;
  count?: number;
  mono?: boolean;
  body?: ReactNode;
}) {
  return (
    <li className={`exf-item${on ? " is-checked" : ""}${partial ? " is-partial" : ""}`}>
      {/* An in-app link that keeps the scroll (Explore updates in place): picking a value re-reads
          the page without reloading it, so the sidebar stays where it was for the next pick. */}
      <Link className={`exf-label tr-flink${mono ? " is-mono" : ""}`} href={href} scroll={false} prefetch={false} aria-current={on ? "true" : undefined} title={on ? `${label}: click to clear` : label}>
        <span className={`tr-fbox${on || partial ? " is-on" : ""}`} aria-hidden="true">
          {on ? <Icon name="check" /> : partial ? <span className="exf-dash" /> : null}
        </span>
        {body ?? <span className="exf-label__text">{label}</span>}
      </Link>
      {count !== undefined ? (
        <span className="exf-count" title={`${count.toLocaleString("en-US")} ${unit}`}>
          {compactCount(count)}
        </span>
      ) : null}
      <Link className="exf-only" href={only} scroll={false} prefetch={false} aria-label={`Only ${label}`}>
        Only
      </Link>
    </li>
  );
}
