import { PageHeader } from "@/components/page-header";
import { LoadingState } from "@/components/states";
import { ORG_SETTINGS } from "@/lib/data";

// While an Organization settings page loads (#1051): only the content pane changes; the shell and
// the section menu (from `layout.tsx`) stay as they are.
export default function Loading() {
  return (
    <div className="page page--narrow os">
      <PageHeader title={ORG_SETTINGS.label} lead={ORG_SETTINGS.lead} />
      <LoadingState label="Loading organization settings…" variant="form" />
    </div>
  );
}
