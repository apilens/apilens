import type { ExploreState } from "@/lib/explore";
import type { RequestRow, RequestTimeline } from "@/lib/identity";
import { RequestLog } from "./request-log";
import "./explore.css";

/**
 * `/<project>/explore` (#585). The request log: every request the SDK reported, newest first.
 * `rows` (and `timeline`, #587) is null when the API could not answer.
 */
export function ExploreView({
  project,
  projectName,
  environments,
  query,
  rows,
  timeline,
  now,
}: {
  project: string;
  projectName: string;
  environments: readonly string[];
  query: ExploreState;
  rows: RequestRow[] | null;
  timeline: RequestTimeline | null;
  now: number;
}) {
  return (
    <div className="ex">
      <header className="pagehead">
        <p className="cp-h">{projectName} · Explore</p>
        <h1 className="cp-lede">Explore</h1>
        <p className="ex-lead">Every request your API served, newest first, as the SDK reported it.</p>
      </header>
      <RequestLog project={project} environments={environments} query={query} initial={rows} timeline={timeline} now={now} />
    </div>
  );
}
