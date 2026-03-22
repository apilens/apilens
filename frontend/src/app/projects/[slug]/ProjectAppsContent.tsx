"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Plus, ArrowLeft, Box, Trash2, MoreVertical, ArrowRight } from "lucide-react";
import Image from "next/image";
import type { AppListItem } from "@/types/app";

interface ProjectAppsContentProps {
  slug: string;
}

const FRAMEWORK_META: Record<string, { label: string; icon: string }> = {
  fastapi: { label: "FastAPI", icon: "/frameworks/fastapi.svg" },
  flask: { label: "Flask", icon: "/frameworks/flask.svg" },
  django: { label: "Django", icon: "/frameworks/django.svg" },
  starlette: { label: "Starlette", icon: "/frameworks/starlette.svg" },
  express: { label: "Express", icon: "/frameworks/express.svg" },
};

export default function ProjectAppsContent({ slug }: ProjectAppsContentProps) {
  const router = useRouter();
  const [apps, setApps] = useState<AppListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState<string | null>(null);
  const menuRef = useRef<{ [key: string]: HTMLDivElement | null }>({});

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

  useEffect(() => {
    if (!openMenuId) return;
    const handleClickOutside = (e: MouseEvent) => {
      const currentMenu = menuRef.current[openMenuId];
      if (currentMenu && !currentMenu.contains(e.target as Node)) {
        setOpenMenuId(null);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [openMenuId]);

  const formatDate = (dateStr: string) =>
    new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });

  const handleDelete = async (app: AppListItem) => {
    if (!window.confirm(`Delete "${app.name}"? This cannot be undone.`)) return;

    setIsDeleting(app.id);
    try {
      const res = await fetch(`/api/apps/${app.slug}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to delete app");
      }
      setApps((prev) => prev.filter((a) => a.id !== app.id));
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete app");
    } finally {
      setIsDeleting(null);
      setOpenMenuId(null);
    }
  };

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
        <div className="apps-table-wrapper">
          <table className="apps-table">
            <thead>
              <tr>
                <th>App</th>
                <th>Framework</th>
                <th>Description</th>
                <th>Created</th>
                <th style={{ width: "60px" }}></th>
              </tr>
            </thead>
            <tbody>
              {apps.map((app) => {
                const framework = FRAMEWORK_META[app.framework] || FRAMEWORK_META.fastapi;
                const appAvatar = (app.name.charAt(0) || "A").toUpperCase();
                const isMenuOpen = openMenuId === app.id;
                const isAppDeleting = isDeleting === app.id;

                return (
                  <tr
                    key={app.id}
                    className="apps-table-row"
                    onClick={() => router.push(`/projects/${slug}/endpoints?app=${app.slug}`)}
                    style={{ cursor: "pointer" }}
                  >
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                        {app.icon_url ? (
                          <img
                            src={app.icon_url}
                            alt={app.name}
                            style={{
                              width: "40px",
                              height: "40px",
                              borderRadius: "8px",
                              objectFit: "cover"
                            }}
                          />
                        ) : (
                          <div style={{
                            width: "40px",
                            height: "40px",
                            borderRadius: "8px",
                            background: "var(--color-primary)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            fontSize: "16px",
                            fontWeight: "600",
                            color: "white"
                          }}>
                            {appAvatar}
                          </div>
                        )}
                        <div>
                          <div style={{ fontWeight: 500, fontSize: "14px" }}>{app.name}</div>
                          <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                            {app.slug}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                        <Image
                          src={framework.icon}
                          alt={framework.label}
                          width={16}
                          height={16}
                        />
                        <span style={{ fontSize: "14px" }}>{framework.label}</span>
                      </div>
                    </td>
                    <td>
                      <div style={{
                        fontSize: "14px",
                        color: "var(--text-secondary)",
                        maxWidth: "300px",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap"
                      }}>
                        {app.description || "—"}
                      </div>
                    </td>
                    <td>
                      <div style={{ fontSize: "14px", color: "var(--text-secondary)" }}>
                        {formatDate(app.created_at)}
                      </div>
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div style={{ position: "relative" }} ref={(el) => { menuRef.current[app.id] = el; }}>
                        <button
                          type="button"
                          className="app-card-menu-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenMenuId(isMenuOpen ? null : app.id);
                          }}
                          style={{
                            background: "none",
                            border: "none",
                            cursor: "pointer",
                            padding: "8px",
                            borderRadius: "6px",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center"
                          }}
                        >
                          <MoreVertical size={16} />
                        </button>
                        {isMenuOpen && (
                          <div className="app-card-menu" style={{
                            position: "absolute",
                            right: 0,
                            top: "100%",
                            marginTop: "4px",
                            zIndex: 10
                          }}>
                            <button
                              type="button"
                              className="app-card-menu-item"
                              onClick={(e) => {
                                e.stopPropagation();
                                setOpenMenuId(null);
                                router.push(`/projects/${slug}/endpoints?app=${app.slug}`);
                              }}
                            >
                              <ArrowRight size={14} />
                              View endpoints
                            </button>
                            <button
                              type="button"
                              className="app-card-menu-item app-card-menu-item-danger"
                              onClick={(e) => {
                                e.stopPropagation();
                                void handleDelete(app);
                              }}
                              disabled={isAppDeleting}
                            >
                              {isAppDeleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                              Delete app
                            </button>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
