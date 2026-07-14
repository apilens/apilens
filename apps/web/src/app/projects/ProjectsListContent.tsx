"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Plus, Loader2, FolderOpen, AlertCircle } from "lucide-react";
import { ProjectCard } from "@/components/projects";
import PasskeyUpsellBanner from "@/components/auth/PasskeyUpsellBanner";
import { Button } from "@/components/reui/button";
import { Alert, AlertDescription } from "@/components/reui/alert";

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
      <div className="mx-auto w-full max-w-[960px]">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-semibold text-foreground">Projects</h1>
        </div>
        <div className="flex min-h-[200px] items-center justify-center gap-3 text-sm text-muted-foreground">
          <Loader2 size={24} strokeWidth={2} className="animate-spin" />
          <span>Loading projects...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[960px]">
      <PasskeyUpsellBanner />
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-foreground">Projects</h1>
        <Button asChild size="sm">
          <Link href="/projects/new">
            <Plus size={16} strokeWidth={2} />
            Create Project
          </Link>
        </Button>
      </div>
      {error ? (
        <Alert variant="destructive" className="mb-4">
          <AlertCircle />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {projects.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 px-6 py-20 text-center">
          <div className="mb-1 text-muted-foreground">
            <FolderOpen size={32} strokeWidth={2} />
          </div>
          <h2 className="text-lg font-semibold text-foreground">No projects yet</h2>
          <p className="mb-2 max-w-[400px] text-sm text-muted-foreground">
            Create your first project to organize your apps and services.
          </p>
          <Button asChild size="sm">
            <Link href="/projects/new">
              <Plus size={16} strokeWidth={2} />
              Create your first project
            </Link>
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
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
