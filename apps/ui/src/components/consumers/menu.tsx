import Link from "next/link";
import type { ReactNode } from "react";
import { type ConsumersQuery, consumersHref } from "@/lib/consumers";
import type { ConsumerGroupTraffic } from "@/lib/identity";
import { Icon } from "../icons";
import { SidePanel } from "../shell/side-panel";
import { Item } from "../traffic/facet-item";
import { STATUS_LEVELS, codeOn, levelState, toggleCode, toggleLevel } from "@/lib/traffic-status";
import { SearchableList } from "../traffic/searchable-list";
import { ConsumersTimeRange } from "./time-range";
import "../explore/explore.css";
import "../traffic/traffic.css";

/**
 * The Consumers sidebar, Explore's and Traffic's facet panel: Time Range, Level (success 2xx–3xx,
 * warning 4xx, error 5xx) at the top, Environment, Group (the groups the SDK reported, with their
 * users), and Status (the codes, searchable) last. Level and Status tick like Traffic's (any mix,
 * partial levels); the others take one value. One value per section; picking one narrows the
 * page to it, again lets it go, its hover Only keeps it alone. Values are in-app links that keep
 * the scroll, so a second pick needs no scrolling back. Reset clears the filters.
 */
export function ConsumersMenu({
  project,
  query: q,
  environments,
  groups,
  statuses,
}: {
  project: string;
  query: ConsumersQuery;
  environments: readonly string[];
  groups: ConsumerGroupTraffic[] | null;
  /** Requests per status code under the range and environment. */
  statuses: { value: string; count: number }[];
}) {
  const href = (patch: Partial<ConsumersQuery>) => consumersHref(project, { ...q, consumer: null, ...patch });
  const any = Boolean(q.env || q.group || q.q || q.app || q.method || q.path || q.pathLike || q.groupLike || q.status);
  const codes = statuses.map((c) => c.value);
  const levelCount = (classes: readonly string[]) => statuses.filter((c) => classes.some((k) => k[0] === c.value[0])).reduce((n, c) => n + c.count, 0);
  const envs = q.env && !environments.includes(q.env) ? [...environments, q.env] : environments;
  const groupRows = groups ?? [];
  const listedGroups = q.group && !groupRows.some((g) => g.group === q.group) ? [{ group: q.group, consumers: 0 }, ...groupRows] : groupRows;
  return (
    <SidePanel
      title="Consumers"
      actions={
        any ? (
          <Link className="exf-reset" href={href({ env: "", group: null, q: "", app: "", method: "", path: "", pathLike: "", groupLike: "", status: "" })} scroll={false} prefetch={false}>
            Reset
          </Link>
        ) : null
      }
    >
      <div className="exf" role="region" aria-label="Filters">
        <div className="exf-scroll">
          <ConsumersTimeRange project={project} query={q} />
          <Section title="Level">
            <ul className="exf-list tr-flist">
              {STATUS_LEVELS.map((l) => (
                <Item
                  key={l.key}
                  on={levelState(q.status, l.classes) === "on"}
                  partial={levelState(q.status, l.classes) === "partial"}
                  href={href({ status: toggleLevel(q.status, l.classes) })}
                  only={href({ status: l.classes.join(",") })}
                  label={l.label}
                  count={levelCount(l.classes)}
                  body={
                    <span className="exf-level">
                      <span className="exf-level__name">{l.label}</span>
                      <span className="exf-level__tag">
                        <span className={`exf-swatch exf-swatch--${l.key}`} aria-hidden="true" />
                        <span className="exf-level__cls">{l.cls}</span>
                      </span>
                    </span>
                  }
                />
              ))}
            </ul>
          </Section>
          {envs.length ? (
            <Section title="Environment">
              <ul className="exf-list tr-flist">
                {envs.map((e) => (
                  <Item key={e} on={q.env === e} href={href({ env: q.env === e ? "" : e })} only={href({ env: e })} label={e} />
                ))}
              </ul>
            </Section>
          ) : null}
          <Section title="Group">
            {groups === null ? (
              <p className="tr-fnote">Couldn’t load groups just now.</p>
            ) : listedGroups.length === 0 ? (
              <p className="tr-fnote">No groups reported in this range. The SDK reports a user’s group with each request.</p>
            ) : (
              <ul className="exf-list tr-flist">
                {listedGroups.map((g) => (
                  <Item
                    key={g.group}
                    on={q.group === g.group}
                    href={href({ group: q.group === g.group ? null : g.group })}
                    only={href({ group: g.group })}
                    label={g.group}
                    count={g.consumers}
                    unit="users"
                  />
                ))}
              </ul>
            )}
          </Section>
          <Section title="Status">
            {statuses.length === 0 ? (
              <p className="tr-fnote">No requests in this range.</p>
            ) : (
              <SearchableList
                label="Status"
                codes
                rows={statuses.map((c) => ({
                  value: c.value,
                  label: c.value,
                  count: c.count,
                  on: codeOn(q.status, c.value),
                  href: href({ status: toggleCode(q.status, c.value, codes) }),
                  only: href({ status: c.value }),
                }))}
              />
            )}
          </Section>
        </div>
      </div>
    </SidePanel>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="exf-facet tr-facet" open>
      <summary className="exf-facet__head">
        <span className="exf-facet__title">
          <span className="tr-facet__btn">
            <span className="exf-facet__name">{title}</span>
            <Icon name="chevronDown" />
          </span>
        </span>
      </summary>
      <div className="exf-facet__body">{children}</div>
    </details>
  );
}
