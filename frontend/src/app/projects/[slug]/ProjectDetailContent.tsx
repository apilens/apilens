"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Loader2, Plus, Layers } from "lucide-react";
import { AppCard } from "@/components/apps";
import type { AppListItem } from "@/types/app";

interface ProjectInfo {
  id: string;
  name: string;
  slug: string;
  description: string;
  created_at: string;
  updated_at: string;
}

interface ProjectDetailContentProps {
  slug: string;
}

export default function ProjectDetailContent({ slug }: ProjectDetailContentProps) {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [apps, setApps] = useState<AppListItem[]>([]);
  const [summary, setSummary] = useState<Record<string, number>>({
    total_requests: 0,
    error_count: 0,
    error_rate: 0,
    avg_response_time_ms: 0,
    p95_response_time_ms: 0,
  });
  const [topEndpoints, setTopEndpoints] = useState<
    Array<{ method: string; path: string; total_requests: number; error_count: number; p95_response_time_ms: number }>
  >([]);

  useEffect(() => {
    if (!slug) {
      setError("No project slug provided");
      setIsLoading(false);
      return;
    }

    async function fetchData() {
      try {
        console.log("Fetching project with slug:", slug);
        // Fetch project details
        const projectRes = await fetch(`/api/projects/${slug}`);
        if (!projectRes.ok) {
          const body = await projectRes.json().catch(() => ({}));
          throw new Error(body.error || "Failed to fetch project");
        }
        const projectData = await projectRes.json();
        setProject(projectData);

        // Fetch apps
        const appsRes = await fetch(`/api/projects/${slug}/apps`);
        if (!appsRes.ok) {
          const body = await appsRes.json().catch(() => ({}));
          throw new Error(body.error || "Failed to fetch apps");
        }
        const appsData = await appsRes.json();
        const appsList = appsData.apps || [];
        setApps(appsList);

        // Fetch analytics
        const appSlugs = appsList.map((a: any) => a.slug);
        const qs = appSlugs.length ? `?app_slugs=${encodeURIComponent(appSlugs.join(","))}` : "";

        const summaryRes = await fetch(`/api/projects/${slug}/analytics/summary${qs}`);
        if (summaryRes.ok) {
          const sumBody = await summaryRes.json();
          setSummary({
            total_requests: Number(sumBody.total_requests) || 0,
            error_count: Number(sumBody.error_count) || 0,
            error_rate: Number(sumBody.error_rate) || 0,
            avg_response_time_ms: Number(sumBody.avg_response_time_ms) || 0,
            p95_response_time_ms: Number(sumBody.p95_response_time_ms) || 0,
          });
        }

        const epRes = await fetch(`/api/projects/${slug}/analytics/endpoints${qs ? `${qs}&limit=5` : "?limit=5"}`);
        if (epRes.ok) {
          const data = await epRes.json();
          setTopEndpoints(data.items || data || []);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to fetch data";
        setError(message);
        console.error(err);
      } finally {
        setIsLoading(false);
      }
    }
    fetchData();
  }, [slug]);

  if (isLoading) {
    return (
      <div className="apps-page">
        <div className="apps-page-loading">
          <Loader2 size={24} strokeWidth={2} className="animate-spin" />
          <span>Loading project...</span>
        </div>
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="apps-page">
        <div className="create-app-error">{error || "Project not found"}</div>
      </div>
    );
  }

  return (
    <div className="apps-page">
      {/* Header */}
      <div className="apps-page-header">
        <div className="apps-page-header-left">
          <div className="apps-page-header-info">
            <h1 className="apps-page-title">{project.name}</h1>
            {project.description && <p className="apps-page-subtitle">{project.description}</p>}
          </div>
        </div>
        <div className="apps-page-header-actions">
          <Link href={`/projects/${slug}/new-app`} className="settings-btn settings-btn-primary">
            <Plus size={16} strokeWidth={2} />
            Create App
          </Link>
        </div>
      </div>

      {/* Key Metrics */}
      <section className="logs-metrics-tabs" aria-label="Project metrics">
        <article className="logs-metric-tab">
          <p className="logs-metric-label">Apps</p>
          <p className="logs-metric-value">{apps.length}</p>
        </article>
        <article className="logs-metric-tab">
          <p className="logs-metric-label">Total Requests</p>
          <p className="logs-metric-value">{formatNumber(summary.total_requests)}</p>
        </article>
        <article className="logs-metric-tab">
          <p className="logs-metric-label">Error Rate</p>
          <p className={`logs-metric-value ${summary.error_rate >= 5 ? "tone-bad" : summary.error_rate >= 2 ? "tone-warn" : "tone-good"}`}>
            {summary.error_rate.toFixed(1)}%
          </p>
        </article>
        <article className="logs-metric-tab">
          <p className="logs-metric-label">Avg Latency</p>
          <p className="logs-metric-value">{Math.round(summary.avg_response_time_ms)} ms</p>
        </article>
        <article className="logs-metric-tab">
          <p className="logs-metric-label">P95 Latency</p>
          <p className="logs-metric-value">{Math.round(summary.p95_response_time_ms)} ms</p>
        </article>
      </section>

      {/* Apps Grid */}
      {apps.length > 0 && (
        <div style={{ marginTop: "2rem" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1rem" }}>
            <h2 className="create-app-page-title">Apps</h2>
            <Link href={`/projects/${slug}/apps`} className="settings-btn settings-btn-secondary" style={{ fontSize: "0.875rem" }}>
              View All
            </Link>
          </div>
          <div className="apps-grid">
            {apps.slice(0, 6).map((app) => (
              <AppCard
                key={app.id}
                app={app}
                projectSlug={slug}
                onDeleted={(id) => setApps((prev) => prev.filter((a) => a.id !== id))}
              />
            ))}
          </div>
          {apps.length > 6 && (
            <div style={{ marginTop: "1rem", textAlign: "center" }}>
              <Link href={`/projects/${slug}/apps`} className="settings-btn">
                View All {apps.length} Apps
              </Link>
            </div>
          )}
        </div>
      )}

      {/* Top Endpoints */}
      {topEndpoints.length > 0 && (
        <div className="create-app-guide">
          <div className="create-app-guide-step" style={{ gridColumn: "1 / -1" }}>
            <div className="create-app-guide-body">
              <h4 className="create-app-page-title">Top Endpoints (Last 24h)</h4>
              <div style={{ marginTop: "1rem" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid var(--color-border)", textAlign: "left" }}>
                      <th style={{ padding: "0.5rem 0", fontSize: "0.75rem", fontWeight: 500, color: "var(--color-text-secondary)" }}>Endpoint</th>
                      <th style={{ padding: "0.5rem 0", fontSize: "0.75rem", fontWeight: 500, color: "var(--color-text-secondary)", textAlign: "right" }}>Requests</th>
                      <th style={{ padding: "0.5rem 0", fontSize: "0.75rem", fontWeight: 500, color: "var(--color-text-secondary)", textAlign: "right" }}>Errors</th>
                      <th style={{ padding: "0.5rem 0", fontSize: "0.75rem", fontWeight: 500, color: "var(--color-text-secondary)", textAlign: "right" }}>P95</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topEndpoints.map((ep) => (
                      <tr key={`${ep.method}-${ep.path}`} style={{ borderBottom: "1px solid var(--color-border)" }}>
                        <td style={{ padding: "0.75rem 0" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                            <span className="endpoint-method">{ep.method}</span>
                            <span className="endpoint-path">{ep.path}</span>
                          </div>
                        </td>
                        <td style={{ padding: "0.75rem 0", textAlign: "right", fontSize: "0.875rem" }}>{formatNumber(ep.total_requests)}</td>
                        <td style={{ padding: "0.75rem 0", textAlign: "right", fontSize: "0.875rem" }}>
                          <span className={ep.error_count > 0 ? "error-rate-high" : ""}>{ep.error_count}</span>
                        </td>
                        <td style={{ padding: "0.75rem 0", textAlign: "right", fontSize: "0.875rem" }}>{Math.round(ep.p95_response_time_ms)} ms</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="create-app-actions" style={{ marginTop: "1.5rem" }}>
                <Link href={`/projects/${slug}/endpoints`} className="settings-btn">
                  View All Endpoints
                </Link>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Empty State */}
      {apps.length === 0 && (
        <div className="create-app-guide">
          <div className="create-app-guide-step" style={{ gridColumn: "1 / -1" }}>
            <div className="create-app-guide-body" style={{ textAlign: "center", padding: "3rem 1rem" }}>
              <Layers size={48} strokeWidth={1.5} style={{ margin: "0 auto 1rem", opacity: 0.3 }} />
              <h4 className="create-app-page-title">No apps yet</h4>
              <p className="apps-page-subtitle">Create your first app to start monitoring your APIs.</p>
              <div className="create-app-actions" style={{ marginTop: "1.5rem", justifyContent: "center" }}>
                <Link href={`/projects/${slug}/new-app`} className="settings-btn settings-btn-primary">
                  <Plus size={16} />
                  Create Your First App
                </Link>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatNumber(value: number | undefined): string {
  if (value == null) return "0";
  return Number(value).toLocaleString();
}
