// GET /api/orgs/{slug}/audit-export?project=&who=&group=&from=&to=: the organization's audit log as
// CSV (#813), the Audit log page's current filter, as the signed-in user. Without `project` it is
// `GET /orgs/{slug}/audit-events/export` (org-wide events and every project the caller can view);
// with one it is that project's `GET /projects/{project}/audit-events/export`, which the API checks
// on its own (`audit.read`). Streamed through by `auditExport` (lib/audit-export.ts), which also
// lists the answers.
import type { NextRequest } from "next/server";
import { isProjectSlug } from "@/lib/api-keys";
import { auditExport } from "@/lib/audit-export";
import { InputError, ROUTE_ERROR_CODES } from "@/lib/auth-routes";
import { parseActivityFilters } from "@/lib/audit";

export async function GET(req: NextRequest, { params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const { project } = parseActivityFilters(req.nextUrl.searchParams);
  return auditExport(req, () => {
    if (!isProjectSlug(org)) throw new InputError(422, ROUTE_ERROR_CODES.validation, "invalid organization");
    return { scope: project ? { project } : { org }, catalogue: { org } };
  });
}
