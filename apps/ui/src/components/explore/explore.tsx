import type { ReactNode } from "react";
import type { ExploreQuery } from "@/lib/explore-query";
import type { NamedApp, RequestRow, RequestTimeline, SavedView } from "@/lib/identity";
import { ExploreApp } from "./explore-app";
import "./explore.css";

/**
 * `/project/<project>/explore` (#585; revamped after Supabase Unified Logs in #1052): every
 * request the SDK reported, newest first, in a full-height page of facets, one toolbar row, a 60px
 * status chart and a virtualised table. `rows` and `timeline` are null when the API could not
 * answer; so is `views` (saved views, #589) and `apps` (the project's apps, #975). `cursor` reads
 * the rows after these. `notice` sits above the toolbar (the onboarding reminder). `me` is the
 * signed-in user's id.
 *
 * The page anatomy (title row, facet panel) is Explore's own for now; it adopts the shared page
 * header and panel primitive of #1051 once both land.
 */
export function ExploreView(props: {
  project: string;
  environments: readonly string[];
  apps: NamedApp[] | null;
  query: ExploreQuery;
  rows: RequestRow[] | null;
  cursor: string;
  timeline: RequestTimeline | null;
  views: SavedView[] | null;
  me: string;
  now: number;
  notice?: ReactNode;
}) {
  return <ExploreApp {...props} />;
}
