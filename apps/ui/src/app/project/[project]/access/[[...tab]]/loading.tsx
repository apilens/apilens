import { PageHeader } from "@/components/page-header";
import { LoadingState } from "@/components/states";
import { ACCESS } from "@/lib/access";

// While an Access sub-page loads (#1051): only the content pane changes; the shell and the section
// menu (from `../layout.tsx`) stay as they are.
export default function Loading() {
  return (
    <div className="page page--narrow os">
      <PageHeader title={ACCESS.label} lead={ACCESS.lead} />
      <LoadingState label="Loading…" />
    </div>
  );
}
