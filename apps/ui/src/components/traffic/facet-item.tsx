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
}: {
  on: boolean;
  href: string;
  /** Keeps this value alone (Explore's hover Only). */
  only: string;
  label: string;
  count?: number;
  mono?: boolean;
  body?: ReactNode;
}) {
  return (
    <li className={`exf-item${on ? " is-checked" : ""}`}>
      <a className={`exf-label tr-flink${mono ? " is-mono" : ""}`} href={href} aria-current={on ? "true" : undefined} title={on ? `${label}: click to clear` : label}>
        <span className={`tr-fbox${on ? " is-on" : ""}`} aria-hidden="true">
          {on ? <Icon name="check" /> : null}
        </span>
        {body ?? <span className="exf-label__text">{label}</span>}
      </a>
      {count !== undefined ? (
        <span className="exf-count" title={`${count.toLocaleString("en-US")} requests`}>
          {compactCount(count)}
        </span>
      ) : null}
      <a className="exf-only" href={only} aria-label={`Only ${label}`}>
        Only
      </a>
    </li>
  );
}
