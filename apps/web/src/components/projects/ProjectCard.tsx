"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Calendar,
  Settings,
  Trash2,
  Ellipsis,
  ArrowRight,
  Loader2,
  FolderOpen,
} from "lucide-react";
import { Button } from "@/components/reui/button";
import { Badge } from "@/components/reui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/reui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/reui/dropdown-menu";

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

  const handleDelete = async (e: { stopPropagation: () => void; preventDefault: () => void }) => {
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

  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={openProject}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openProject();
        }
      }}
      className="cursor-pointer gap-3 py-4 transition-colors hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <CardHeader className="px-4">
        <CardTitle className="truncate text-sm font-semibold text-foreground">
          {project.name}
        </CardTitle>
        <CardAction>
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="More options"
                className="-mt-1 -mr-1 text-muted-foreground"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
              >
                <Ellipsis size={16} strokeWidth={2} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem
                onSelect={() => {
                  setMenuOpen(false);
                  openProject();
                }}
              >
                <ArrowRight size={14} strokeWidth={2} />
                Open project
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link
                  href={`/projects/${project.slug}/settings`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenuOpen(false);
                  }}
                >
                  <Settings size={14} strokeWidth={2} />
                  Settings
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={isDeleting}
                onSelect={(e) => {
                  setMenuOpen(false);
                  void handleDelete(e);
                }}
              >
                {isDeleting ? (
                  <Loader2 size={14} strokeWidth={2} className="animate-spin" />
                ) : (
                  <Trash2 size={14} strokeWidth={2} />
                )}
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </CardAction>
      </CardHeader>

      <CardContent className="px-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5" aria-label="Project">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-sm font-bold text-primary">
              {projectAvatar}
            </span>
            <Badge variant="primary-light" radius="full">
              <FolderOpen strokeWidth={2} />
              {project.app_count} {project.app_count === 1 ? "app" : "apps"}
            </Badge>
          </div>
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <Calendar size={12} strokeWidth={2} />
            {formatDate(project.created_at)}
          </span>
        </div>

        {error ? <p className="mt-3 text-[13px] text-destructive">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
