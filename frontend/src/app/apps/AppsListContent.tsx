"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Plus, Loader2, Box } from "lucide-react";
import { AppCard } from "@/components/apps";
import type { AppListItem } from "@/types/app";

export default function AppsListContent() {
  const [apps, setApps] = useState<AppListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function fetchApps() {
      try {
        const res = await fetch("/api/apps");
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || "Failed to fetch apps");
        }
        const data = await res.json();
        setApps(data.apps);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to fetch apps";
        setError(message);
        console.error(err);
      } finally {
        setIsLoading(false);
      }
    }
    fetchApps();
  }, []);

  if (isLoading) {
    return (
      <div className="apps-page">
        <div className="apps-page-header">
          <h1 className="apps-page-title">Apps</h1>
        </div>
        <div className="apps-page-loading">
          <Loader2 size={24} className="animate-spin" />
          <span>Loading apps...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="apps-page">
      <div className="apps-page-header">
        <h1 className="apps-page-title">Apps</h1>
        <Link href="/apps/new" className="settings-btn settings-btn-primary">
          <Plus size={16} />
          Create App
        </Link>
      </div>
      {error ? <div className="create-app-error">{error}</div> : null}

      {apps.length === 0 ? (
        <div className="apps-empty">
          <div className="apps-empty-icon">
            <Box size={32} />
          </div>
          <h2 className="apps-empty-title">No apps yet</h2>
          <p className="apps-empty-text">
            Create your first app to start monitoring your APIs and generating API keys.
          </p>
          <Link href="/apps/new" className="settings-btn settings-btn-primary">
            <Plus size={16} />
            Create your first app
          </Link>
        </div>
      ) : (
        <div className="apps-grid">
          {apps.map((app) => (
            <AppCard
              key={app.id}
              app={app}
              onDeleted={(id) =>
                setApps((prev) => prev.filter((existing) => existing.id !== id))
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
