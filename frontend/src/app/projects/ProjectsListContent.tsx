"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Plus, Loader2, FolderOpen } from "lucide-react";
import { ProjectCard } from "@/components/projects";

interface ProjectListItem {
  id: string;
  name: string;
  slug: string;
  description: string;
  app_count: number;
  created_at: string;
}

export default function ProjectsListContent() {
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function fetchProjects() {
      try {
        const res = await fetch("/api/projects");
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || "Failed to fetch projects");
        }
        const data = await res.json();
        setProjects(data.projects);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to fetch projects";
        setError(message);
        console.error(err);
      } finally {
        setIsLoading(false);
      }
    }
    fetchProjects();
  }, []);

  if (isLoading) {
    return (
      <div className="apps-page">
        <div className="apps-page-header">
          <h1 className="apps-page-title">Projects</h1>
        </div>
        <div className="apps-page-loading">
          <Loader2 size={24} strokeWidth={2} className="animate-spin" />
          <span>Loading projects...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="apps-page">
      <div className="apps-page-header">
        <h1 className="apps-page-title">Projects</h1>
        <Link href="/projects/new" className="settings-btn settings-btn-primary">
          <Plus size={16} strokeWidth={2} />
          Create Project
        </Link>
      </div>
      {error ? <div className="create-app-error">{error}</div> : null}

      {projects.length === 0 ? (
        <div className="apps-empty">
          <div className="apps-empty-icon">
            <FolderOpen size={32} strokeWidth={2} />
          </div>
          <h2 className="apps-empty-title">No projects yet</h2>
          <p className="apps-empty-text">
            Create your first project to organize your apps and services.
          </p>
          <Link href="/projects/new" className="settings-btn settings-btn-primary">
            <Plus size={16} strokeWidth={2} />
            Create your first project
          </Link>
        </div>
      ) : (
        <div className="apps-grid">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              onDeleted={(id) =>
                setProjects((prev) => prev.filter((existing) => existing.id !== id))
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
