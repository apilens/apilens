import { INCIDENTS_LEAD } from "@/components/alerts/common";
import { PageHeader } from "@/components/page-header";
import { LoadingState } from "@/components/states";

// While Alert rules or a rule loads (#1051): only the content pane changes.
export default function Loading() {
  return (
    <div className="page al">
      <PageHeader title="Incidents" lead={INCIDENTS_LEAD} section="Alert rules" />
      <LoadingState label="Loading alert rules…" />
    </div>
  );
}
