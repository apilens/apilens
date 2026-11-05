import type { ExploreState } from "@/lib/explore";
import type { RequestRow } from "@/lib/identity";
import { RequestLog } from "./request-log";
import "./explore.css";

/**
 * `/<project>/explore` (#585). The request log: every request the SDK reported, newest first.
 * `rows` is null when the API could not answer.
 */
export function ExploreView({
  project,
  projectName,
  query,
  rows,
  now,
}: {
  project: string;
  projectName: string;
  query: ExploreState;
  rows: RequestRow[] | null;
  now: number;
}) {
  return (
    <div className="ex">
      <header className="pagehead">
        <p className="cp-h">{projectName} · Explore</p>
        <h1 className="cp-lede">Explore</h1>
        <p className="ex-lead">Every request your API served, newest first, as the SDK reported it.</p>
      </header>
      <RequestLog project={project} query={query} initial={rows} now={now} />
    </div>
  );
}
