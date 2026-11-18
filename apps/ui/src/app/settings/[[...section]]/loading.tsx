import { PageHeader } from "@/components/page-header";
import { LoadingState } from "@/components/states";
import { ACCOUNT_SETTINGS } from "@/lib/account-settings";

// While an Account settings section loads (#1051): only the content pane changes; the shell and the
// section menu (from `../layout.tsx`) stay as they are.
export default function Loading() {
  return (
    <div className="page page--narrow acct">
      <PageHeader title={ACCOUNT_SETTINGS.label} lead={ACCOUNT_SETTINGS.lead} />
      <LoadingState label="Loading account settings…" variant="form" />
    </div>
  );
}
