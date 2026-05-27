"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Calendar,
  Settings,
  Trash2,
  Ellipsis,
  ArrowRight,
  Loader2,
  FolderOpen,
  Box,
} from "lucide-react";

interface ProjectListItem {
  id: string;
  name: string;
  slug: string;
  description: string;
  app_count: number;
  created_at: string;
}

interface ProjectCardProps {
  project: ProjectListItem;
  onDeleted?: (id: string) => void;
}

export default function ProjectCard({ project, onDeleted }: ProjectCardProps) {
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

  const projectAvatar = (project.name.charAt(0) || "P").toUpperCase().slice(0, 2);

  const openProject = () => {
    router.push(`/projects/${project.slug}`);
  };

  const handleDelete = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    e.preventDefault();
    if (isDeleting) return;
    if (!window.confirm(`Delete "${project.name}"? This will also delete all apps within this project. This cannot be undone.`)) return;

    setIsDeleting(true);
    setError("");
    try {
      const res = await fetch(`/api/projects/${project.slug}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to delete project");
      }
      onDeleted?.(project.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete project");
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
      onClick={openProject}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openProject();
        }
      }}
    >
      <div className="app-card-header">
        <h3 className="app-card-name">{project.name}</h3>
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
            <Ellipsis size={16} strokeWidth={2} />
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
                  openProject();
                }}
              >
                <ArrowRight size={14} strokeWidth={2} />
                Open project
              </button>
              <Link
                href={`/projects/${project.slug}/settings`}
                className="app-card-menu-item"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen(false);
                }}
              >
                <Settings size={14} strokeWidth={2} />
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
                {isDeleting ? <Loader2 size={14} strokeWidth={2} className="animate-spin" /> : <Trash2 size={14} strokeWidth={2} />}
                Delete
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <div className="app-card-meta-row">
        <div className="app-card-icon-overlay" aria-label="Project">
          <span className="app-card-logo app-card-logo-app">
            {projectAvatar}
          </span>
          <span className="app-card-logo app-card-logo-framework" style={{
            background: "linear-gradient(145deg, #6366f1, #8b5cf6)"
          }}>
            <FolderOpen size={14} strokeWidth={2} />
          </span>
          <span className="app-card-framework-bottom">
            {project.app_count} {project.app_count === 1 ? "app" : "apps"}
          </span>
        </div>
        <span className="app-card-meta">
          <Calendar size={12} strokeWidth={2} />
          {formatDate(project.created_at)}
        </span>
      </div>

      {error ? <p className="app-card-error">{error}</p> : null}
    </article>
  );
}
