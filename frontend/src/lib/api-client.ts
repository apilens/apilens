import { getSession, setSession, clearSession } from "./session";

const DJANGO_API_URL = process.env.DJANGO_API_URL || "http://localhost:8000/api/v1";

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

export interface AppInfo {
  id: string;
  name: string;
  slug: string;
  description: string;
  created_at: string;
  updated_at: string;
}

export interface AppListItem {
  id: string;
  name: string;
  slug: string;
  description: string;
  api_key_count: number;
  created_at: string;
}

export interface ConsumerStats {
  consumer: string;
  total_requests: number;
  error_count: number;
  error_rate: number;
  avg_response_time_ms: number;
  last_seen_at: string | null;
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
  avg_response_time_ms: number;
  p95_response_time_ms: number;
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

async function fetchDjango<T>(
  endpoint: string,
  options: RequestInit = {},
): Promise<ApiResponse<T>> {
  const session = await getSession();
  if (!session) {
    return { error: "Not authenticated", status: 401 };
  }

  const url = `${DJANGO_API_URL}${endpoint}`;

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

async function refreshTokens(
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string } | null> {
  try {
    const response = await fetch(`${DJANGO_API_URL}/auth/refresh`, {
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

  // ── Apps ──────────────────────────────────────────────────────────

  async getApps(): Promise<ApiResponse<AppListItem[]>> {
    return fetchDjango<AppListItem[]>("/apps/");
  },

  async getApp(slug: string): Promise<ApiResponse<AppInfo>> {
    return fetchDjango<AppInfo>(`/apps/${slug}`);
  },

  async createApp(data: { name: string; description?: string }): Promise<ApiResponse<AppInfo>> {
    return fetchDjango<AppInfo>("/apps/", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  async updateApp(slug: string, data: { name?: string; description?: string }): Promise<ApiResponse<AppInfo>> {
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
      `/apps/${slug}/endpoint-stats${qs ? `?${qs}` : ""}`,
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

  async getAnalyticsSummary(
    slug: string,
    params?: { environment?: string; since?: string; until?: string },
  ): Promise<ApiResponse<AnalyticsSummary>> {
    const searchParams = new URLSearchParams();
    if (params?.environment) searchParams.set("environment", params.environment);
    if (params?.since) searchParams.set("since", params.since);
    if (params?.until) searchParams.set("until", params.until);
    const qs = searchParams.toString();
    return fetchDjango<AnalyticsSummary>(
      `/apps/${slug}/analytics/summary${qs ? `?${qs}` : ""}`,
    );
  },

  async getAnalyticsTimeseries(
    slug: string,
    params?: { environment?: string; since?: string; until?: string },
  ): Promise<ApiResponse<AnalyticsTimeseriesPoint[]>> {
    const searchParams = new URLSearchParams();
    if (params?.environment) searchParams.set("environment", params.environment);
    if (params?.since) searchParams.set("since", params.since);
    if (params?.until) searchParams.set("until", params.until);
    const qs = searchParams.toString();
    return fetchDjango<AnalyticsTimeseriesPoint[]>(
      `/apps/${slug}/analytics/timeseries${qs ? `?${qs}` : ""}`,
    );
  },

  async getRelatedApis(
    slug: string,
    params?: { environment?: string; since?: string; until?: string; limit?: number },
  ): Promise<ApiResponse<RelatedApi[]>> {
    const searchParams = new URLSearchParams();
    if (params?.environment) searchParams.set("environment", params.environment);
    if (params?.since) searchParams.set("since", params.since);
    if (params?.until) searchParams.set("until", params.until);
    if (params?.limit) searchParams.set("limit", String(params.limit));
    const qs = searchParams.toString();
    return fetchDjango<RelatedApi[]>(
      `/apps/${slug}/analytics/related-apis${qs ? `?${qs}` : ""}`,
    );
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
    params: { method: string; path: string; environment?: string; since?: string; until?: string },
  ): Promise<ApiResponse<EndpointTimeseriesPoint[]>> {
    const searchParams = new URLSearchParams();
    searchParams.set("method", params.method);
    searchParams.set("path", params.path);
    if (params.environment) searchParams.set("environment", params.environment);
    if (params.since) searchParams.set("since", params.since);
    if (params.until) searchParams.set("until", params.until);
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

  async setPassword(data: {
    new_password: string;
    confirm_password: string;
    current_password?: string;
  }): Promise<ApiResponse<{ message: string }>> {
    return fetchDjango<{ message: string }>("/users/me/password", {
      method: "POST",
      body: JSON.stringify(data),
    });
  },

  async validateSession(refreshToken: string): Promise<ApiResponse<{ valid: boolean }>> {
    try {
      const response = await fetch(`${DJANGO_API_URL}/auth/validate`, {
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
