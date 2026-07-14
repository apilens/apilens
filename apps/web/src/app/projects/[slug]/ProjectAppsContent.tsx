"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Plus, ArrowLeft, Box, Trash2, MoreVertical, ArrowRight, BookOpen, Settings, AlertCircle } from "lucide-react";
import Image from "next/image";
import type { AppListItem } from "@/types/app";
import { Button } from "@/components/reui/button";
import { Alert, AlertDescription } from "@/components/reui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/reui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/reui/dropdown-menu";

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
      const res = await fetch(`/api/projects/${slug}/apps/${app.slug}`, { method: "DELETE" });
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
      <div className="mx-auto w-full max-w-[960px]">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-semibold text-foreground">Apps</h1>
        </div>
        <div className="flex min-h-[200px] items-center justify-center gap-3 text-sm text-muted-foreground">
          <Loader2 size={24} strokeWidth={2} className="animate-spin" />
          <span>Loading apps...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto w-full max-w-[960px]">
        <div className="mb-6 flex items-center justify-between">
          <Button asChild variant="outline" size="sm">
            <Link href={`/projects/${slug}/apps`}>
              <ArrowLeft size={16} strokeWidth={2} />
              Back to Apps
            </Link>
          </Button>
        </div>
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[960px]">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-foreground">Apps</h1>
        <Button asChild size="sm">
          <Link href={`/projects/${slug}/new-app`}>
            <Plus size={16} strokeWidth={2} />
            Create App
          </Link>
        </Button>
      </div>

      {apps.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 px-6 py-20 text-center">
          <div className="mb-1 text-muted-foreground">
            <Box size={32} strokeWidth={2} />
          </div>
          <h2 className="text-lg font-semibold text-foreground">No apps yet</h2>
          <p className="mb-2 max-w-[400px] text-sm text-muted-foreground">
            Create your first app in this project to start monitoring your APIs.
          </p>
          <Button asChild size="sm">
            <Link href={`/projects/${slug}/new-app`}>
              <Plus size={16} strokeWidth={2} />
              Create your first app
            </Link>
          </Button>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>App</TableHead>
                <TableHead>Framework</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-[60px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apps.map((app) => {
                const framework = FRAMEWORK_META[app.framework] || FRAMEWORK_META.fastapi;
                const appAvatar = (app.name.charAt(0) || "A").toUpperCase();
                const isMenuOpen = openMenuId === app.id;
                const isAppDeleting = isDeleting === app.id;

                return (
                  <TableRow
                    key={app.id}
                    className="cursor-pointer"
                    onClick={() => router.push(`/projects/${slug}/endpoints?app=${app.slug}`)}
                  >
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary text-base font-semibold text-primary-foreground">
                          {appAvatar}
                        </div>
                        <div>
                          <div className="text-sm font-medium text-foreground">{app.name}</div>
                          <div className="text-xs text-muted-foreground">{app.slug}</div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Image
                          src={framework.icon}
                          alt={framework.label}
                          width={16}
                          height={16}
                        />
                        <span className="text-sm">{framework.label}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="max-w-[300px] truncate text-sm text-muted-foreground">
                        {app.description || "—"}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm text-muted-foreground">
                        {formatDate(app.created_at)}
                      </div>
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu
                        open={isMenuOpen}
                        onOpenChange={(open) => setOpenMenuId(open ? app.id : null)}
                      >
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label="App actions"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <MoreVertical size={16} />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-48">
                          <DropdownMenuItem
                            onSelect={() => {
                              setOpenMenuId(null);
                              router.push(`/projects/${slug}/endpoints?app=${app.slug}`);
                            }}
                          >
                            <ArrowRight size={14} />
                            View endpoints
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => {
                              setOpenMenuId(null);
                              router.push(`/projects/${slug}/apps/${app.slug}/settings/general`);
                            }}
                          >
                            <Settings size={14} />
                            App settings
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => {
                              setOpenMenuId(null);
                              router.push(`/projects/${slug}/apps/${app.slug}/settings/setup`);
                            }}
                          >
                            <BookOpen size={14} />
                            Setup guide
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            disabled={isAppDeleting}
                            onSelect={() => {
                              void handleDelete(app);
                            }}
                          >
                            {isAppDeleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                            Delete app
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
