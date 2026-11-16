// GET /api/projects/{slug}/audit-export?who=&group=&from=&to=: the project's activity log as CSV
// (#812), the Activity tab's current filter, from `GET /projects/{slug}/audit-events/export`
// (#784) as the signed-in user, streamed through by `auditExport` (lib/audit-export.ts), which
// also lists the answers.
import type { NextRequest } from "next/server";
import { isProjectSlug } from "@/lib/api-keys";
import { auditExport } from "@/lib/audit-export";
import { InputError, ROUTE_ERROR_CODES } from "@/lib/auth-routes";

export async function GET(req: NextRequest, { params }: { params: Promise<{ project: string }> }) {
  const { project } = await params;
  return auditExport(req, () => {
    if (!isProjectSlug(project)) throw new InputError(422, ROUTE_ERROR_CODES.validation, "invalid project");
    return { scope: { project }, catalogue: { project } };
  });
}
