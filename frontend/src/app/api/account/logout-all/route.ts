import { withAuth, apiResult } from "@/lib/proxy";
import { apiClient } from "@/lib/api-client";

export const POST = () =>
  withAuth(async () => apiResult(await apiClient.logoutAll()));
