import { PageHeader } from "@/components/page-header";
import { LoadingState } from "@/components/states";
import { PROJECT_SETTINGS } from "@/lib/data";

// While a Project settings section loads (#1051): only the content pane changes; the shell and the
// section menu (from `../layout.tsx`) stay as they are.
export default function Loading() {
  return (
    <div className="page page--narrow os">
      <PageHeader title={PROJECT_SETTINGS.label} lead={PROJECT_SETTINGS.lead} />
      <LoadingState label="Loading this section…" variant="form" />
    </div>
  );
}
