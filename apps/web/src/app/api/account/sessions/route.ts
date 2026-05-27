import { withAuth, apiResult } from "@/lib/proxy";
import { apiClient } from "@/lib/api-client";

export const GET = () =>
  withAuth(async () => apiResult(await apiClient.getSessions(), "sessions"));
