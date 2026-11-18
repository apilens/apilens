import type { ReactNode } from "react";
import type { ExploreQuery } from "@/lib/explore-query";
import type { NamedApp, RequestRow, RequestTimeline } from "@/lib/identity";
import { SidePanel } from "../shell/side-panel";
import { ExploreApp } from "./explore-app";
import { FACETS_ACTIONS_ID, FACETS_SLOT_ID } from "./slots";
import "./explore.css";

/**
 * `/project/<project>/explore` (#585; revamped after Supabase Unified Logs in #1052, #1061): every
 * request the SDK reported, newest first: one toolbar row (the filter box with the time range in
 * it), the 60px chart and a virtualised table, with the request in a drawer from the right. No
 * title row: the page's name heads its secondary sidebar (ExploreMenu). `rows` and `timeline` are
 * null when the API could not answer; so is `apps` (the project's apps, #975). `cursor` reads the
 * rows after these. `notice` sits above the toolbar (the onboarding reminder).
 */
export function ExploreView(props: {
  project: string;
  environments: readonly string[];
  apps: NamedApp[] | null;
  query: ExploreQuery;
  rows: RequestRow[] | null;
  cursor: string;
  timeline: RequestTimeline | null;
  now: number;
  notice?: ReactNode;
}) {
  return <ExploreApp {...props} />;
}

/**
 * Explore's secondary sidebar (#1061): the shell's SidePanel (#1051, the same width, 48px header,
 * borders and scroll as Project settings' menu) titled "Explore", whose body and header actions
 * are slots the page portals its facets and their Reset into, so they keep the page's state.
 */
export function ExploreMenu() {
  return (
    <SidePanel title="Explore" actions={<span id={FACETS_ACTIONS_ID} className="exf-actions" />}>
      <div id={FACETS_SLOT_ID} className="exf-slot" />
    </SidePanel>
  );
}
