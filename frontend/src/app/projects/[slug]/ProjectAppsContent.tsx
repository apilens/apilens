"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Plus, ArrowLeft, Box } from "lucide-react";
import { AppCard } from "@/components/apps";
import type { AppListItem } from "@/types/app";

interface ProjectAppsContentProps {
  slug: string;
}

export default function ProjectAppsContent({ slug }: ProjectAppsContentProps) {
  const [apps, setApps] = useState<AppListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function fetchApps() {
      try {
        const res = await fetch(`/api/projects/${slug}/apps`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || "Failed to fetch apps");
        }
        const data = await res.json();
        setApps(data.apps || []);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to fetch apps";
        setError(message);
      } finally {
        setLoading(false);
      }
    }
    fetchApps();
  }, [slug]);

  if (loading) {
    return (
      <div className="apps-page">
        <div className="apps-page-header">
          <h1 className="apps-page-title">Apps</h1>
        </div>
        <div className="apps-page-loading">
          <Loader2 size={24} strokeWidth={2} className="animate-spin" />
          <span>Loading apps...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="apps-page">
        <div className="apps-page-header">
          <Link href={`/projects/${slug}`} className="settings-btn">
            <ArrowLeft size={16} strokeWidth={2} />
            Back to Overview
          </Link>
        </div>
        <div className="create-app-error">{error}</div>
      </div>
    );
  }

  return (
    <div className="apps-page">
      <div className="apps-page-header">
        <h1 className="apps-page-title">Apps</h1>
        <Link href={`/projects/${slug}/new-app`} className="settings-btn settings-btn-primary">
          <Plus size={16} strokeWidth={2} />
          Create App
        </Link>
      </div>

      {apps.length === 0 ? (
        <div className="apps-empty">
          <div className="apps-empty-icon">
            <Box size={32} strokeWidth={2} />
          </div>
          <h2 className="apps-empty-title">No apps yet</h2>
          <p className="apps-empty-text">Create your first app in this project to start monitoring your APIs.</p>
          <Link href={`/projects/${slug}/new-app`} className="settings-btn settings-btn-primary">
            <Plus size={16} strokeWidth={2} />
            Create your first app
          </Link>
        </div>
      ) : (
        <div className="apps-grid">
          {apps.map((app) => (
            <AppCard
              key={app.id}
              app={app}
              projectSlug={slug}
              onDeleted={(id) => setApps((prev) => prev.filter((existing) => existing.id !== id))}
            />
          ))}
        </div>
      )}
    </div>
  );
}
