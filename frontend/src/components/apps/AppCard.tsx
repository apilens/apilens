"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Calendar,
  Settings,
  Trash2,
  Ellipsis,
  ArrowRight,
  Loader2,
} from "lucide-react";
import type { AppListItem } from "@/types/app";

interface AppCardProps {
  app: AppListItem;
  onDeleted?: (id: string) => void;
}

const FRAMEWORK_META: Record<
  AppListItem["framework"],
  { label: string; icon: string }
> = {
  fastapi: { label: "FastAPI", icon: "/frameworks/fastapi.svg" },
  flask: { label: "Flask", icon: "/frameworks/flask.svg" },
  django: { label: "Django", icon: "/frameworks/django.svg" },
  starlette: { label: "Starlette", icon: "/frameworks/starlette.svg" },
};

export default function AppCard({ app, onDeleted }: AppCardProps) {
  const router = useRouter();
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const formatDate = (dateStr: string) =>
    new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });

  const framework = FRAMEWORK_META[app.framework] || FRAMEWORK_META.fastapi;
  const appAvatar = (app.name.charAt(0) || "A").slice(0, 2);

  const openApp = () => {
    router.push(`/apps/${app.slug}/endpoints`);
  };

  const handleDelete = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    e.preventDefault();
    if (isDeleting) return;
    if (!window.confirm(`Delete "${app.name}"? This cannot be undone.`)) return;

    setIsDeleting(true);
    setError("");
    try {
      const res = await fetch(`/api/apps/${app.slug}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to delete app");
      }
      onDeleted?.(app.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete app");
    } finally {
      setIsDeleting(false);
    }
  };

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (ev: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(ev.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [menuOpen]);

  return (
    <article
      className="app-card app-card-clickable"
      role="button"
      tabIndex={0}
      onClick={openApp}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openApp();
        }
      }}
    >
      <div className="app-card-header">
        <h3 className="app-card-name">{app.name}</h3>
        <div className="app-card-menu-wrap" ref={menuRef}>
          <button
            type="button"
            className="app-card-menu-btn"
            aria-label="More options"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setMenuOpen((prev) => !prev);
            }}
          >
            <Ellipsis size={16} />
          </button>
          {menuOpen ? (
            <div className="app-card-menu">
              <button
                type="button"
                className="app-card-menu-item"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setMenuOpen(false);
                  openApp();
                }}
              >
                <ArrowRight size={14} />
                Open app
              </button>
              <Link
                href={`/apps/${app.slug}/settings/general`}
                className="app-card-menu-item"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                }}
              >
                <Settings size={14} />
                Settings
              </Link>
              <button
                type="button"
                className="app-card-menu-item app-card-menu-item-danger"
                onClick={(e) => {
                  setMenuOpen(false);
                  void handleDelete(e);
                }}
                disabled={isDeleting}
              >
                {isDeleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                Delete
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <div className="app-card-meta-row">
        <div className="app-card-icon-overlay" aria-label={`${framework.label} app`}>
          {app.icon_url ? (
            <span className="app-card-logo app-card-logo-app app-card-logo-image-wrap">
              <img src={app.icon_url} alt={app.name} className="app-card-logo-image" />
            </span>
          ) : (
            <span className="app-card-logo app-card-logo-app">{appAvatar}</span>
          )}
          <span className="app-card-logo app-card-logo-framework">
            <Image
              src={framework.icon}
              alt={framework.label}
              width={14}
              height={14}
              className="app-card-framework-icon"
            />
          </span>
          <span className="app-card-framework-bottom">{framework.label}</span>
        </div>
        <span className="app-card-meta">
          <Calendar size={12} />
          {formatDate(app.created_at)}
        </span>
      </div>

      {app.description && (
        <p className="app-card-description">{app.description}</p>
      )}

      {error ? <p className="app-card-error">{error}</p> : null}
    </article>
  );
}
