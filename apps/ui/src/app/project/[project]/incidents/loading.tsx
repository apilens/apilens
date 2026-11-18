import { INCIDENTS_LEAD } from "@/components/alerts/common";
import { PageHeader } from "@/components/page-header";
import { LoadingState } from "@/components/states";

// While an Incidents page loads (#1051): the feed, an incident's timeline, the alert rules or the
// rule editor. Only the content pane changes; the shell and the section menu (from `layout.tsx`)
// stay as they are.
export default function Loading() {
  return (
    <div className="page al">
      <PageHeader title="Incidents" lead={INCIDENTS_LEAD} />
      <LoadingState label="Loading incidents…" />
    </div>
  );
}
