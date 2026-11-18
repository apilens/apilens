import type { ExploreState } from "@/lib/explore";
import type { FilterSuggestions } from "@/lib/explore-filters";
import type { NamedApp, RequestRow, RequestTimeline, SavedView } from "@/lib/identity";
import { PageHeader } from "../page-header";
import { AppNamesProvider } from "./app-names";
import { ExportMenu } from "./export";
import { RequestLog } from "./request-log";
import { SavedViews, ViewSwitcher } from "./saved-views";
import "./explore.css";

/**
 * `/<project>/explore` (#585). The request log: every request the SDK reported, newest first.
 * `rows` (and `timeline`, #587) is null when the API could not answer; so is `views`, the saved
 * views (#589) the header's switcher lists, beside Export (#590), and so is `apps`, the project's
 * apps (#975) the App filter offers and the App column names. `me` is the signed-in user's id.
 */
export function ExploreView({
  project,
  projectName,
  environments,
  suggestions,
  apps,
  query,
  rows,
  trail,
  older,
  timeline,
  views,
  me,
  now,
}: {
  project: string;
  projectName: string;
  environments: readonly string[];
  /** The endpoints and consumers the Path and Consumer filters suggest (#983). */
  suggestions?: FilterSuggestions;
  apps: NamedApp[] | null;
  query: ExploreState;
  rows: RequestRow[] | null;
  /** The cursors walked back to this page of the log (empty on the newest page). */
  trail: string[];
  /** The API's cursor of the rows older than these ("" when there are none). */
  older: string;
  timeline: RequestTimeline | null;
  views: SavedView[] | null;
  me: string;
  now: number;
}) {
  return (
    <div className="page ex">
      <AppNamesProvider apps={apps}>
        <SavedViews project={project} me={me} query={query} initial={views}>
          <PageHeader project={project} projectName={projectName} title="Explore" lead="Every request your API served, newest first, as the SDK reported it." />
          {/* One toolbar row: range, filters, then the saved view and Export at the right edge. */}
          <RequestLog
            project={project}
            environments={environments}
            suggestions={suggestions}
            apps={apps}
            query={query}
            initial={rows}
            trail={trail}
            older={older}
            timeline={timeline}
            now={now}
            actions={
              <>
                <ViewSwitcher />
                <ExportMenu project={project} query={query} />
              </>
            }
          />
        </SavedViews>
      </AppNamesProvider>
    </div>
  );
}
