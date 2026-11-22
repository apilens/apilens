import Link from "next/link";
import type { ReactNode } from "react";
import { type ConsumersQuery, consumersHref } from "@/lib/consumers";
import type { ConsumerGroupTraffic } from "@/lib/identity";
import { Icon } from "../icons";
import { SidePanel } from "../shell/side-panel";
import { Item } from "../traffic/facet-item";
import { ConsumersTimeRange } from "./time-range";
import "../explore/explore.css";
import "../traffic/traffic.css";

/**
 * The Consumers sidebar, Explore's and Traffic's facet panel: Time Range, Environment and Group
 * (the groups the SDK reported, with their users). One value per section; picking one narrows the
 * page to it, again lets it go, its hover Only keeps it alone. Values are in-app links that keep
 * the scroll, so a second pick needs no scrolling back. Reset clears the filters.
 */
export function ConsumersMenu({
  project,
  query: q,
  environments,
  groups,
}: {
  project: string;
  query: ConsumersQuery;
  environments: readonly string[];
  groups: ConsumerGroupTraffic[] | null;
}) {
  const href = (patch: Partial<ConsumersQuery>) => consumersHref(project, { ...q, consumer: null, ...patch });
  const any = Boolean(q.env || q.group || q.q || q.app || q.method || q.path);
  const envs = q.env && !environments.includes(q.env) ? [...environments, q.env] : environments;
  const groupRows = groups ?? [];
  const listedGroups = q.group && !groupRows.some((g) => g.group === q.group) ? [{ group: q.group, consumers: 0 }, ...groupRows] : groupRows;
  return (
    <SidePanel
      title="Consumers"
      actions={
        any ? (
          <Link className="exf-reset" href={href({ env: "", group: null, q: "", app: "", method: "", path: "" })} scroll={false} prefetch={false}>
            Reset
          </Link>
        ) : null
      }
    >
      <div className="exf" role="region" aria-label="Filters">
        <div className="exf-scroll">
          <ConsumersTimeRange project={project} query={q} />
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
