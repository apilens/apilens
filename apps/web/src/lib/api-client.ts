import { getSession, setSession, clearSession } from "./session";
import type { FrameworkId } from "@/types/app";

const DJANGO_API_URL = process.env.DJANGO_API_URL || "http://localhost:8000/api/v1";

// Identity (IAM) service base for token issuance/validation. In production
// AUTH_API_URL points at the dedicated identity service (internal
// http://identity:8000/v1); when unset it falls back to the core API's /auth
// path so local dev is unchanged. (Authenticated settings calls — 2FA, etc. —
// keep flowing through fetchDjango / the back-compat alias.)
const AUTH_API_URL =
  process.env.AUTH_API_URL || `${DJANGO_API_URL}/auth`;

export interface ApiResponse<T> {
  data?: T;
  error?: string;
  status: number;
}

export interface DjangoUser {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  display_name: string;
  picture: string;
  email_verified: boolean;
  has_password: boolean;
  timezone: string;
  created_at: string;
  last_login_at: string | null;
}

export interface DjangoUserContext {
  id: string;
  email: string;
  display_name: string;
  picture: string;
  is_authenticated: boolean;
  permissions: string[];
  role: string;
}

export interface SessionInfo {
  id: string;
  device_info: string;
  ip_address: string | null;
  location: string;
  last_used_at: string;
  created_at: string;
  is_current: boolean;
}

export interface ApiKeyInfo {
  id: string;
  name: string;
  prefix: string;
  last_used_at: string | null;
  created_at: string;
}

export interface ApiKeyCreateResult {
  key: string;
  id: string;
  name: string;
  prefix: string;
  created_at: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  slug: string;
  description: string;
  created_at: string;
  updated_at: string;
}

export type ProjectRole = "owner" | "admin" | "member" | "viewer";

export interface ProjectMember {
  id: string | null;
  user_id: string;
  email: string;
  name: string;
  role: ProjectRole;
  is_owner: boolean;
  is_you: boolean;
}

export interface ProjectInvitation {
  id: string;
  email: string;
  role: ProjectRole;
  expires_at: string;
  created_at: string;
}

export interface ProjectMembersResult {
  members: ProjectMember[];
  invitations: ProjectInvitation[];
  your_role: ProjectRole;
}

export interface InviteInfo {
  valid: boolean;
  email: string;
  role: ProjectRole | "";
  project_name: string;
  project_slug: string;
  inviter: string;
}

export interface PendingInvitation {
  id: string;
  project_name: string;
  project_slug: string;
  role: ProjectRole;
  inviter: string;
  created_at: string;
  expires_at: string;
}

export interface AcceptResult {
  message: string;
  project_slug: string;
  project_name: string;
}

export interface ProjectListItem {
  id: string;
  name: string;
  slug: string;
  description: string;
  app_count: number;
  created_at: string;
}

export interface AppInfo {
  id: string;
  name: string;
  slug: string;
  icon_url: string;
  description: string;
  framework: FrameworkId;
  created_at: string;
  updated_at: string;
}

export interface AppListItem {
  id: string;
  name: string;
  slug: string;
  icon_url: string;
  description: string;
  framework: FrameworkId;
  api_key_count: number;
  created_at: string;
}

export interface ConsumerStats {
  consumer: string;
  consumer_identifier: string;
  consumer_name: string;
  consumer_group: string;
  total_requests: number;
  error_count: number;
  error_rate: number;
  avg_response_time_ms: number;
  last_seen_at: string | null;
}

export interface ConsumerRequestStat {
  consumer: string;
  method: string;
  path: string;
  total_requests: number;
  error_count: number;
  error_rate: number;
  avg_response_time_ms: number;
  last_seen_at: string | null;
}

export interface ConsumerActivityItem {
  timestamp: string;
  method: string;
  path: string;
  status_code: number;
  response_time_ms: number;
  environment: string;
  consumer_id: string;
  consumer_name: string;
  consumer_group: string;
  request_payload: string;
  response_payload: string;
}

export interface AnalyticsSummary {
  total_requests: number;
  error_count: number;
  error_rate: number;
  avg_response_time_ms: number;
  p95_response_time_ms: number;
  total_request_bytes: number;
  total_response_bytes: number;
  unique_endpoints: number;
  unique_consumers: number;
}

export interface AnalyticsTimeseriesPoint {
  bucket: string;
  total_requests: number;
  error_count: number;
  error_rate: number;
  avg_response_time_ms: number | null;
  p95_response_time_ms: number | null;
  total_request_bytes: number;
  total_response_bytes: number;
}

export interface RelatedApi {
  family: string;
  endpoint_count: number;
  total_requests: number;
  error_count: number;
  error_rate: number;
  avg_response_time_ms: number;
}

export interface EndpointDetail {
  method: string;
  path: string;
  total_requests: number;
  error_count: number;
  error_rate: number;
  avg_response_time_ms: number;
  p95_response_time_ms: number;
  total_request_bytes: number;
  total_response_bytes: number;
  last_seen_at: string | null;
}

export interface EndpointMeta {
  id: string;
  method: string;
  path: string;
}

export interface EndpointTimeseriesPoint {
  bucket: string;
  total_requests: number;
  error_count: number;
  avg_response_time_ms: number;
}

export interface EndpointConsumer {
  consumer: string;
  total_requests: number;
  error_count: number;
  error_rate: number;
  avg_response_time_ms: number;
}

export interface EndpointStatusCode {
  status_code: number;
  total_requests: number;
}

export interface EndpointPayloadSample {
  timestamp: string;
  method: string;
  path: string;
  status_code: number;
  response_time_ms: number;
  environment: string;
  ip_address: string;
  user_agent: string;
  consumer_id: string;
  consumer_name: string;
  consumer_group: string;
  request_payload: string;
  response_payload: string;
}

export interface EnvironmentOption {
  environment: string;
  total_requests: number;
}

async function fetchDjango<T>(
  endpoint: string,
  options: RequestInit = {},
): Promise<ApiResponse<T>> {
  const session = await getSession();
  if (!session) {
    return { error: "Not authenticated", status: 401 };
  }

  // Auth/identity endpoints (2FA, etc.) live on the identity service, not the
  // core API. Route "/auth/*" to AUTH_API_URL (dropping the "/auth" segment,
  // since AUTH_API_URL is already the auth base); everything else -> core.
  const url = endpoint.startsWith("/auth/")
    ? `${AUTH_API_URL}${endpoint.slice("/auth".length)}`
    : `${DJANGO_API_URL}${endpoint}`;

  try {
    let response = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.accessToken}`,
        ...options.headers,
      },
    });

    // Auto-refresh on 401
    if (response.status === 401) {
      const refreshResult = await refreshTokens(session.refreshToken);
      if (!refreshResult) {
        await clearSession();
        return { error: "Session expired", status: 401 };
      }

      response = await fetch(url, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${refreshResult.accessToken}`,
          ...options.headers,
        },
      });
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return {
        error: errorData.detail || errorData.error || `Request failed with status ${response.status}`,
        status: response.status,
      };
    }

    const data = await response.json();
    return { data, status: response.status };
  } catch (error) {
    console.error(`API error (${endpoint}):`, error);
    return {
      error: error instanceof Error ? error.message : "Unknown error",
      status: 500,
    };
  }
}

// Refresh-token rotation is single-use with family-reuse detection on the
// backend: presenting an already-rotated token wipes the whole session family.
// The dashboard fires many parallel requests that all carry the SAME refresh
// token, so on a 401 wave they must ALL resolve to the one rotated token —
// never re-present the old one. We coalesce two ways, keyed by the presented
// token:
//   • in-flight map  — concurrent callers share the one /refresh promise;
//   • recent cache   — callers that 401 just *after* it settled still get the
//                      already-rotated result instead of refreshing again.
type RefreshResult = { accessToken: string; refreshToken: string } | null;
const REFRESH_CACHE_TTL_MS = 15_000;
const refreshInflight = new Map<string, Promise<RefreshResult>>();
const refreshRecent = new Map<string, { result: RefreshResult; at: number }>();

async function refreshTokens(refreshToken: string): Promise<RefreshResult> {
  const cached = refreshRecent.get(refreshToken);
  if (cached && Date.now() - cached.at < REFRESH_CACHE_TTL_MS) {
    return cached.result;
  }

  const existing = refreshInflight.get(refreshToken);
  if (existing) return existing;

  const inflight = (async (): Promise<RefreshResult> => {
    try {
      const response = await fetch(`${AUTH_API_URL}/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });

      if (!response.ok) return null;

      const data = await response.json();

      const session = await getSession();
      if (session) {
        await setSession({
          ...session,
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
        });
      }

      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
      };
    } catch {
      return null;
    }
  })();

  refreshInflight.set(refreshToken, inflight);
  try {
    const result = await inflight;
    // Remember the outcome briefly so the rest of the herd reuses it.
    refreshRecent.set(refreshToken, { result, at: Date.now() });
    if (refreshRecent.size > 50) {
      const cutoff = Date.now() - REFRESH_CACHE_TTL_MS;
      for (const [key, val] of refreshRecent) {
        if (val.at < cutoff) refreshRecent.delete(key);
      }
    }
    return result;
  } finally {
    refreshInflight.delete(refreshToken);
  }
}

export const apiClient = {
  async getCurrentUser(): Promise<ApiResponse<DjangoUser>> {
    return fetchDjango<DjangoUser>("/users/me");
  },

  async getUserContext(): Promise<ApiResponse<DjangoUserContext>> {
    return fetchDjango<DjangoUserContext>("/users/context");
  },

  async updateProfile(data: {
    first_name?: string;
    last_name?: string;
    timezone?: string;
  }): Promise<ApiResponse<DjangoUser>> {
    return fetchDjango<DjangoUser>("/users/me", {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  },

  async deleteAccount(): Promise<ApiResponse<{ message: string }>> {
    return fetchDjango<{ message: string }>("/users/me", {
      method: "DELETE",
    });
  },

  async logoutAll(): Promise<ApiResponse<{ message: string }>> {
    return fetchDjango<{ message: string }>("/users/logout-all", {
      method: "POST",
    });
  },

  async logoutOthers(): Promise<ApiResponse<{ message: string }>> {
    return fetchDjango<{ message: string }>("/users/logout-others", {
      method: "POST",
    });
  },

  // ── Two-Factor Authentication ─────────────────────────────────────
  // These go through fetchDjango so they automatically refresh the access
  // token if it's expired (15-min lifetime). Otherwise a stale settings tab
  // would throw 401 the first time the user touches a 2FA action.

  async twoFactorStatus(): Promise<ApiResponse<{ enabled: boolean; backup_codes_remaining: number }>> {
    return fetchDjango("/auth/2fa/status");
  },

  async twoFactorEnable(): Promise<ApiResponse<{ secret: string; qr_code_uri: string }>> {
    return fetchDjango("/auth/2fa/enable", { method: "POST" });
  },

  async twoFactorVerify(payload: { code: string; password?: string }): Promise<ApiResponse<{ codes: string[] }>> {
    return fetchDjango("/auth/2fa/verify", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async twoFactorDisable(payload: { password?: string; code?: string; backup_code?: string }): Promise<ApiResponse<{ message: string }>> {
    return fetchDjango("/auth/2fa/disable", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async twoFactorRegenerateBackupCodes(): Promise<ApiResponse<{ codes: string[] }>> {
    return fetchDjango("/auth/2fa/backup-codes/regenerate", { method: "POST" });
  },

  async setPassword(payload: {
    new_password: string;
    confirm_password: string;
    current_password?: string;
  }): Promise<ApiResponse<{ message: string; access_token: string; refresh_token: string }>> {
    return fetchDjango("/users/me/password", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  },

  async getSessions(): Promise<ApiResponse<SessionInfo[]>> {
    return fetchDjango<SessionInfo[]>("/users/sessions");
  },

  async revokeSession(
    sessionId: string,
  ): Promise<ApiResponse<{ message: string }>> {
    return fetchDjango<{ message: string }>(`/users/sessions/${sessionId}`, {
      method: "DELETE",
    });
  },

  async uploadPicture(file: Blob): Promise<ApiResponse<{ picture: string; message: string }>> {
    const session = await getSession();
    if (!session) {
      return { error: "Not authenticated", status: 401 };
    }

    const formData = new FormData();
    formData.append("file", file, "profile.jpg");

    const url = `${DJANGO_API_URL}/users/me/picture`;

    try {
      let response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
        },
        body: formData,
      });

      if (response.status === 401) {
        const refreshResult = await refreshTokens(session.refreshToken);
        if (!refreshResult) {
          await clearSession();
          return { error: "Session expired", status: 401 };
        }

        response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${refreshResult.accessToken}`,
          },
          body: formData,
        });
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return {
          error: errorData.detail || errorData.message || "Upload failed",
          status: response.status,
        };
      }

      const data = await response.json();
      return { data, status: response.status };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Upload failed",
        status: 500,
      };
    }
  },

  async removePicture(): Promise<ApiResponse<{ message: string }>> {
    return fetchDjango<{ message: string }>("/users/me/picture", {
      method: "DELETE",
    });
  },

  // ── Projects ──────────────────────────────────────────────────────

  async getProjects(): Promise<ApiResponse<ProjectListItem[]>> {
    return fetchDjango<ProjectListItem[]>("/projects/");
  },

  async getProject(slug: string): Promise<ApiResponse<ProjectInfo>> {
    return fetchDjango<ProjectInfo>(`/projects/${slug}`);
  },

  async createProject(data: { name: string; description?: string }): Promise<ApiResponse<ProjectInfo>> {
    return fetchDjango<ProjectInfo>("/projects/", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  async updateProject(slug: string, data: { name?: string; description?: string }): Promise<ApiResponse<ProjectInfo>> {
    return fetchDjango<ProjectInfo>(`/projects/${slug}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  },

  async deleteProject(slug: string): Promise<ApiResponse<{ message: string }>> {
    return fetchDjango<{ message: string }>(`/projects/${slug}`, {
      method: "DELETE",
    });
  },

  // ── Project-scoped API Keys ────────────────────────────────────────

  async getProjectApiKeys(projectSlug: string): Promise<ApiResponse<ApiKeyInfo[]>> {
    return fetchDjango<ApiKeyInfo[]>(`/projects/${projectSlug}/api-keys`);
  },

  async createProjectApiKey(projectSlug: string, name: string): Promise<ApiResponse<ApiKeyCreateResult>> {
    return fetchDjango<ApiKeyCreateResult>(`/projects/${projectSlug}/api-keys`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  },

  async revokeProjectApiKey(projectSlug: string, keyId: string): Promise<ApiResponse<{ message: string }>> {
    return fetchDjango<{ message: string }>(`/projects/${projectSlug}/api-keys/${keyId}`, {
      method: "DELETE",
    });
  },

  // ── Project Members & Invitations ──────────────────────────────────

  async getProjectMembers(projectSlug: string): Promise<ApiResponse<ProjectMembersResult>> {
    return fetchDjango<ProjectMembersResult>(`/projects/${projectSlug}/members`);
  },

  async inviteProjectMember(projectSlug: string, email: string, role: string): Promise<ApiResponse<ProjectInvitation>> {
    return fetchDjango<ProjectInvitation>(`/projects/${projectSlug}/members/invite`, {
      method: "POST",
      body: JSON.stringify({ email, role }),
    });
  },

  async updateMemberRole(projectSlug: string, memberId: string, role: string): Promise<ApiResponse<{ message: string }>> {
    return fetchDjango<{ message: string }>(`/projects/${projectSlug}/members/${memberId}`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    });
  },

  async removeProjectMember(projectSlug: string, memberId: string): Promise<ApiResponse<{ message: string }>> {
    return fetchDjango<{ message: string }>(`/projects/${projectSlug}/members/${memberId}`, {
      method: "DELETE",
    });
  },

  async revokeProjectInvitation(projectSlug: string, inviteId: string): Promise<ApiResponse<{ message: string }>> {
    return fetchDjango<{ message: string }>(`/projects/${projectSlug}/invitations/${inviteId}`, {
      method: "DELETE",
    });
  },

  async getInviteInfo(token: string): Promise<ApiResponse<InviteInfo>> {
    return fetchDjango<InviteInfo>(`/auth/invite-info`, {
      method: "POST",
      body: JSON.stringify({ token }),
    });
  },

  async acceptInvitation(token: string): Promise<ApiResponse<AcceptResult>> {
    return fetchDjango<AcceptResult>(`/projects/invitations/accept`, {
      method: "POST",
      body: JSON.stringify({ token }),
    });
  },

  async declineInvitationByToken(token: string): Promise<ApiResponse<{ message: string }>> {
    return fetchDjango<{ message: string }>(`/projects/invitations/decline`, {
      method: "POST",
      body: JSON.stringify({ token }),
    });
  },

  async getPendingInvitations(): Promise<ApiResponse<PendingInvitation[]>> {
    return fetchDjango<PendingInvitation[]>(`/projects/invitations/pending`);
  },

  async acceptInvitationById(inviteId: string): Promise<ApiResponse<AcceptResult>> {
    return fetchDjango<AcceptResult>(`/projects/invitations/${inviteId}/accept`, {
      method: "POST",
    });
  },

  async declineInvitation(inviteId: string): Promise<ApiResponse<{ message: string }>> {
    return fetchDjango<{ message: string }>(`/projects/invitations/${inviteId}/decline`, {
      method: "POST",
    });
  },

  // ── Apps (Project-scoped) ─────────────────────────────────────────

  async getProjectApps(projectSlug: string): Promise<ApiResponse<AppListItem[]>> {
    return fetchDjango<AppListItem[]>(`/projects/${projectSlug}/apps`);
  },

  async createProjectApp(projectSlug: string, data: { name: string; slug?: string; description?: string; framework?: "fastapi" | "flask" | "django" | "starlette" }): Promise<ApiResponse<AppInfo>> {
    return fetchDjango<AppInfo>(`/projects/${projectSlug}/apps`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  async getProjectApp(projectSlug: string, appSlug: string): Promise<ApiResponse<AppInfo>> {
    return fetchDjango<AppInfo>(`/projects/${projectSlug}/apps/${appSlug}`);
  },

  async updateProjectApp(projectSlug: string, appSlug: string, data: { name?: string; description?: string; framework?: string }): Promise<ApiResponse<AppInfo>> {
    return fetchDjango<AppInfo>(`/projects/${projectSlug}/apps/${appSlug}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  },

  async deleteProjectApp(projectSlug: string, appSlug: string): Promise<ApiResponse<{ message: string }>> {
    return fetchDjango<{ message: string }>(`/projects/${projectSlug}/apps/${appSlug}`, {
      method: "DELETE",
    });
  },

  async getApps(): Promise<ApiResponse<AppListItem[]>> {
    return fetchDjango<AppListItem[]>("/apps/");
  },

  async getApp(slug: string): Promise<ApiResponse<AppInfo>> {
    return fetchDjango<AppInfo>(`/apps/${slug}`);
  },

  async createApp(data: { name: string; description?: string; framework?: FrameworkId }): Promise<ApiResponse<AppInfo>> {
    return fetchDjango<AppInfo>("/apps/", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  async updateApp(slug: string, data: { name?: string; description?: string; framework?: FrameworkId }): Promise<ApiResponse<AppInfo>> {
    return fetchDjango<AppInfo>(`/apps/${slug}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
  },

  async deleteApp(slug: string): Promise<ApiResponse<{ message: string }>> {
    return fetchDjango<{ message: string }>(`/apps/${slug}`, {
      method: "DELETE",
    });
  },

  async uploadAppIcon(slug: string, file: Blob): Promise<ApiResponse<{ icon_url: string; message: string }>> {
    const session = await getSession();
    if (!session) return { error: "Not authenticated", status: 401 };

    const formData = new FormData();
    formData.append("file", file, "app-icon.jpg");
    const url = `${DJANGO_API_URL}/apps/${slug}/icon`;

    try {
      let response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.accessToken}` },
        body: formData,
      });

      if (response.status === 401) {
        const refreshResult = await refreshTokens(session.refreshToken);
        if (!refreshResult) {
          await clearSession();
          return { error: "Session expired", status: 401 };
        }
        response = await fetch(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${refreshResult.accessToken}` },
          body: formData,
        });
      }

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return {
          error: errorData.detail || errorData.error || "Upload failed",
          status: response.status,
        };
      }
      return { data: await response.json(), status: response.status };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "Upload failed", status: 500 };
    }
  },

  async removeAppIcon(slug: string): Promise<ApiResponse<{ message: string }>> {
    return fetchDjango<{ message: string }>(`/apps/${slug}/icon`, { method: "DELETE" });
  },

  // ── App-scoped API Keys ────────────────────────────────────────────

  async getAppApiKeys(slug: string): Promise<ApiResponse<ApiKeyInfo[]>> {
    return fetchDjango<ApiKeyInfo[]>(`/apps/${slug}/api-keys`);
  },

  async createAppApiKey(slug: string, name: string): Promise<ApiResponse<ApiKeyCreateResult>> {
    return fetchDjango<ApiKeyCreateResult>(`/apps/${slug}/api-keys`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  },

  async revokeAppApiKey(slug: string, keyId: string): Promise<ApiResponse<{ message: string }>> {
    return fetchDjango<{ message: string }>(`/apps/${slug}/api-keys/${keyId}`, {
      method: "DELETE",
    });
  },

  async getProjectAppApiKeys(projectSlug: string, appSlug: string): Promise<ApiResponse<{ keys: ApiKeyInfo[] }>> {
    return fetchDjango<{ keys: ApiKeyInfo[] }>(`/projects/${projectSlug}/apps/${appSlug}/api-keys`);
  },

  async createProjectAppApiKey(projectSlug: string, appSlug: string, data: { name: string }): Promise<ApiResponse<ApiKeyCreateResult>> {
    return fetchDjango<ApiKeyCreateResult>(`/projects/${projectSlug}/apps/${appSlug}/api-keys`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  async revokeProjectAppApiKey(projectSlug: string, appSlug: string, keyId: string): Promise<ApiResponse<{ message: string }>> {
    return fetchDjango<{ message: string }>(`/projects/${projectSlug}/apps/${appSlug}/api-keys/${keyId}`, {
      method: "DELETE",
    });
  },

  // ── App-scoped Environments ─────────────────────────────────────────

  async getEnvironments(slug: string): Promise<ApiResponse<import("@/types/app").Environment[]>> {
    return fetchDjango<import("@/types/app").Environment[]>(`/apps/${slug}/environments`);
  },

  async createEnvironment(slug: string, data: { name: string; color?: string }): Promise<ApiResponse<import("@/types/app").Environment>> {
    return fetchDjango<import("@/types/app").Environment>(`/apps/${slug}/environments`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  async deleteEnvironment(slug: string, envSlug: string): Promise<ApiResponse<{ message: string }>> {
    return fetchDjango<{ message: string }>(`/apps/${slug}/environments/${envSlug}`, {
      method: "DELETE",
    });
  },

  // ── App-scoped Endpoint Stats ───────────────────────────────────────

  async getEndpointStats(
    slug: string,
    params?: {
      environment?: string;
      since?: string;
      until?: string;
      appSlugs?: string[];
      status_classes?: Array<"2xx" | "3xx" | "4xx" | "5xx">;
      status_codes?: number[];
      status_class?: "2xx" | "3xx" | "4xx" | "5xx";
      status_code?: number;
      methods?: string[];
      paths?: string[];
      endpoints?: string[];
      q?: string;
      sort_by?: "endpoint" | "total_requests" | "error_rate" | "avg_response_time_ms" | "p95_response_time_ms" | "data_transfer" | "last_seen_at";
      sort_dir?: "asc" | "desc";
      page?: number;
      page_size?: number;
    },
  ): Promise<ApiResponse<import("@/types/app").EndpointStatsListResponse>> {
    const searchParams = new URLSearchParams();
    if (params?.environment) searchParams.set("environment", params.environment);
    if (params?.since) searchParams.set("since", params.since);
    if (params?.until) searchParams.set("until", params.until);
    if (params?.status_classes && params.status_classes.length > 0) {
      searchParams.set("status_classes", params.status_classes.join(","));
    }
    if (params?.status_codes && params.status_codes.length > 0) {
      searchParams.set("status_codes", params.status_codes.join(","));
    }
    if (params?.appSlugs && params.appSlugs.length > 0) {
      searchParams.set("app_slugs", params.appSlugs.join(","));
    }
    if (params?.status_class) searchParams.set("status_class", params.status_class);
    if (params?.status_code) searchParams.set("status_code", String(params.status_code));
    if (params?.methods && params.methods.length > 0) {
      searchParams.set("methods", params.methods.join(","));
    }
    if (params?.paths && params.paths.length > 0) {
      searchParams.set("paths", params.paths.join(","));
    }
    if (params?.endpoints && params.endpoints.length > 0) {
      for (const endpoint of params.endpoints) searchParams.append("endpoint", endpoint);
    }
    if (params?.q) searchParams.set("q", params.q);
    if (params?.sort_by) searchParams.set("sort_by", params.sort_by);
    if (params?.sort_dir) searchParams.set("sort_dir", params.sort_dir);
    if (params?.page) searchParams.set("page", String(params.page));
    if (params?.page_size) searchParams.set("page_size", String(params.page_size));
    const qs = searchParams.toString();
    return fetchDjango<import("@/types/app").EndpointStatsListResponse>(
      `/projects/${slug}/analytics/endpoints${qs ? `?${qs}` : ""}`,
    );
  },

  async getEndpointOptions(
    slug: string,
    params?: {
      environment?: string;
      since?: string;
      until?: string;
      status_classes?: Array<"2xx" | "3xx" | "4xx" | "5xx">;
      status_codes?: number[];
      methods?: string[];
      q?: string;
      limit?: number;
    },
  ): Promise<ApiResponse<import("@/types/app").EndpointOption[]>> {
    const searchParams = new URLSearchParams();
    if (params?.environment) searchParams.set("environment", params.environment);
    if (params?.since) searchParams.set("since", params.since);
    if (params?.until) searchParams.set("until", params.until);
    if (params?.status_classes && params.status_classes.length > 0) {
      searchParams.set("status_classes", params.status_classes.join(","));
    }
    if (params?.status_codes && params.status_codes.length > 0) {
      searchParams.set("status_codes", params.status_codes.join(","));
    }
    if (params?.methods && params.methods.length > 0) {
      searchParams.set("methods", params.methods.join(","));
    }
    if (params?.q) searchParams.set("q", params.q);
    if (params?.limit) searchParams.set("limit", String(params.limit));
    const qs = searchParams.toString();
    return fetchDjango<import("@/types/app").EndpointOption[]>(
      `/apps/${slug}/endpoint-options${qs ? `?${qs}` : ""}`,
    );
  },

  async getEnvironmentOptions(
    slug: string,
    params?: { since?: string; until?: string; limit?: number },
  ): Promise<ApiResponse<EnvironmentOption[]>> {
    const searchParams = new URLSearchParams();
    if (params?.since) searchParams.set("since", params.since);
    if (params?.until) searchParams.set("until", params.until);
    if (params?.limit) searchParams.set("limit", String(params.limit));
    const qs = searchParams.toString();
    return fetchDjango<EnvironmentOption[]>(
      `/apps/${slug}/environment-options${qs ? `?${qs}` : ""}`,
    );
  },

  async getConsumerStats(
    slug: string,
    params?: { environment?: string; since?: string; until?: string; limit?: number },
  ): Promise<ApiResponse<ConsumerStats[]>> {
    const searchParams = new URLSearchParams();
    if (params?.environment) searchParams.set("environment", params.environment);
    if (params?.since) searchParams.set("since", params.since);
    if (params?.until) searchParams.set("until", params.until);
    if (params?.limit) searchParams.set("limit", String(params.limit));
    const qs = searchParams.toString();
    return fetchDjango<ConsumerStats[]>(
      `/apps/${slug}/consumers${qs ? `?${qs}` : ""}`,
    );
  },

  async getConsumerRequestStats(
    slug: string,
    params: {
      consumer: string;
      environment?: string;
      since?: string;
      until?: string;
      limit?: number;
    },
  ): Promise<ApiResponse<ConsumerRequestStat[]>> {
    const searchParams = new URLSearchParams();
    searchParams.set("consumer", params.consumer);
    if (params.environment) searchParams.set("environment", params.environment);
    if (params.since) searchParams.set("since", params.since);
    if (params.until) searchParams.set("until", params.until);
    if (params.limit) searchParams.set("limit", String(params.limit));
    const qs = searchParams.toString();
    return fetchDjango<ConsumerRequestStat[]>(
      `/apps/${slug}/consumers/requests${qs ? `?${qs}` : ""}`,
    );
  },

  async getConsumerActivity(
    slug: string,
    params: {
      consumer: string;
      environment?: string;
      since?: string;
      until?: string;
      method?: string;
      path?: string;
      limit?: number;
    },
  ): Promise<ApiResponse<ConsumerActivityItem[]>> {
    const searchParams = new URLSearchParams();
    searchParams.set("consumer", params.consumer);
    if (params.environment) searchParams.set("environment", params.environment);
    if (params.since) searchParams.set("since", params.since);
    if (params.until) searchParams.set("until", params.until);
    if (params.method) searchParams.set("method", params.method);
    if (params.path) searchParams.set("path", params.path);
    if (params.limit) searchParams.set("limit", String(params.limit));
    const qs = searchParams.toString();
    return fetchDjango<ConsumerActivityItem[]>(
      `/apps/${slug}/consumers/activity${qs ? `?${qs}` : ""}`,
    );
  },

  async getAnalyticsSummary(
    slug: string,
    params?: { environment?: string; since?: string; until?: string; appSlugs?: string[] },
  ): Promise<ApiResponse<AnalyticsSummary>> {
    const searchParams = new URLSearchParams();
    if (params?.environment) searchParams.set("environment", params.environment);
    if (params?.since) searchParams.set("since", params.since);
    if (params?.until) searchParams.set("until", params.until);
    if (params?.appSlugs && params.appSlugs.length > 0) {
      searchParams.set("app_slugs", params.appSlugs.join(","));
    }
    const qs = searchParams.toString();
    return fetchDjango<AnalyticsSummary>(`/projects/${slug}/analytics/summary${qs ? `?${qs}` : ""}`);
  },

  async getAnalyticsTimeseries(
    slug: string,
    params?: { environment?: string; since?: string; until?: string; appSlugs?: string[]; timezone?: string },
  ): Promise<ApiResponse<AnalyticsTimeseriesPoint[]>> {
    const searchParams = new URLSearchParams();
    if (params?.environment) searchParams.set("environment", params.environment);
    if (params?.since) searchParams.set("since", params.since);
    if (params?.until) searchParams.set("until", params.until);
    if (params?.timezone) searchParams.set("timezone", params.timezone);
    if (params?.appSlugs && params.appSlugs.length > 0) {
      searchParams.set("app_slugs", params.appSlugs.join(","));
    }
    const qs = searchParams.toString();
    return fetchDjango<AnalyticsTimeseriesPoint[]>(`/projects/${slug}/analytics/timeseries${qs ? `?${qs}` : ""}`);
  },

  async getRelatedApis(
    slug: string,
    params?: { environment?: string; since?: string; until?: string; limit?: number; appSlugs?: string[] },
  ): Promise<ApiResponse<RelatedApi[]>> {
    const searchParams = new URLSearchParams();
    if (params?.environment) searchParams.set("environment", params.environment);
    if (params?.since) searchParams.set("since", params.since);
    if (params?.until) searchParams.set("until", params.until);
    if (params?.limit) searchParams.set("limit", String(params.limit));
    if (params?.appSlugs && params.appSlugs.length > 0) {
      searchParams.set("app_slugs", params.appSlugs.join(","));
    }
    const qs = searchParams.toString();
    return fetchDjango<RelatedApi[]>(`/projects/${slug}/analytics/related-apis${qs ? `?${qs}` : ""}`);
  },

  async getEndpointDetail(
    slug: string,
    params: { method: string; path: string; environment?: string; since?: string; until?: string },
  ): Promise<ApiResponse<EndpointDetail>> {
    const searchParams = new URLSearchParams();
    searchParams.set("method", params.method);
    searchParams.set("path", params.path);
    if (params.environment) searchParams.set("environment", params.environment);
    if (params.since) searchParams.set("since", params.since);
    if (params.until) searchParams.set("until", params.until);
    const qs = searchParams.toString();
    return fetchDjango<EndpointDetail>(
      `/apps/${slug}/analytics/endpoint-detail${qs ? `?${qs}` : ""}`,
    );
  },

  async getEndpointTimeseries(
    slug: string,
    params: { method: string; path: string; environment?: string; since?: string; until?: string; timezone?: string },
  ): Promise<ApiResponse<EndpointTimeseriesPoint[]>> {
    const searchParams = new URLSearchParams();
    searchParams.set("method", params.method);
    searchParams.set("path", params.path);
    if (params.environment) searchParams.set("environment", params.environment);
    if (params.since) searchParams.set("since", params.since);
    if (params.until) searchParams.set("until", params.until);
    if (params.timezone) searchParams.set("timezone", params.timezone);
    const qs = searchParams.toString();
    return fetchDjango<EndpointTimeseriesPoint[]>(
      `/apps/${slug}/analytics/endpoint-timeseries${qs ? `?${qs}` : ""}`,
    );
  },

  async getEndpointConsumers(
    slug: string,
    params: { method: string; path: string; environment?: string; since?: string; until?: string; limit?: number },
  ): Promise<ApiResponse<EndpointConsumer[]>> {
    const searchParams = new URLSearchParams();
    searchParams.set("method", params.method);
    searchParams.set("path", params.path);
    if (params.environment) searchParams.set("environment", params.environment);
    if (params.since) searchParams.set("since", params.since);
    if (params.until) searchParams.set("until", params.until);
    if (params.limit) searchParams.set("limit", String(params.limit));
    const qs = searchParams.toString();
    return fetchDjango<EndpointConsumer[]>(
      `/apps/${slug}/analytics/endpoint-consumers${qs ? `?${qs}` : ""}`,
    );
  },

  async getEndpointStatusCodes(
    slug: string,
    params: { method: string; path: string; environment?: string; since?: string; until?: string; limit?: number },
  ): Promise<ApiResponse<EndpointStatusCode[]>> {
    const searchParams = new URLSearchParams();
    searchParams.set("method", params.method);
    searchParams.set("path", params.path);
    if (params.environment) searchParams.set("environment", params.environment);
    if (params.since) searchParams.set("since", params.since);
    if (params.until) searchParams.set("until", params.until);
    if (params.limit) searchParams.set("limit", String(params.limit));
    const qs = searchParams.toString();
    return fetchDjango<EndpointStatusCode[]>(
      `/apps/${slug}/analytics/endpoint-status-codes${qs ? `?${qs}` : ""}`,
    );
  },

  async getEndpointPayloads(
    slug: string,
    params: { method: string; path: string; environment?: string; since?: string; until?: string; limit?: number },
  ): Promise<ApiResponse<EndpointPayloadSample[]>> {
    const searchParams = new URLSearchParams();
    searchParams.set("method", params.method);
    searchParams.set("path", params.path);
    if (params.environment) searchParams.set("environment", params.environment);
    if (params.since) searchParams.set("since", params.since);
    if (params.until) searchParams.set("until", params.until);
    if (params.limit) searchParams.set("limit", String(params.limit));
    const qs = searchParams.toString();
    return fetchDjango<EndpointPayloadSample[]>(
      `/apps/${slug}/analytics/endpoint-payloads${qs ? `?${qs}` : ""}`,
    );
  },

  async getEndpointMeta(
    slug: string,
    endpointId: string,
  ): Promise<ApiResponse<EndpointMeta>> {
    const qs = new URLSearchParams();
    qs.set("endpoint_id", endpointId);
    return fetchDjango<EndpointMeta>(`/apps/${slug}/endpoint-meta?${qs.toString()}`);
  },

  async validateSession(refreshToken: string): Promise<ApiResponse<{ valid: boolean }>> {
    try {
      const response = await fetch(`${AUTH_API_URL}/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      const data = await response.json();
      return { data, status: response.status };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Validation failed",
        status: 500,
      };
    }
  },

  async healthCheck(): Promise<
    ApiResponse<{ status: string; service: string }>
  > {
    try {
      const response = await fetch(`${DJANGO_API_URL}/health`);
      const data = await response.json();
      return { data, status: response.status };
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : "Unknown error",
        status: 500,
      };
    }
  },
};
