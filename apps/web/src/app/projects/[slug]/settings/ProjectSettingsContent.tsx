"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Loader2, X, Check, Copy, Lock, SearchX } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/reui/button";
import { Input } from "@/components/reui/input";
import { Label } from "@/components/reui/label";
import { Textarea } from "@/components/reui/textarea";
import SettingsCard from "@/components/settings/SettingsCard";
import ProjectApiKeysSection from "@/components/projects/ProjectApiKeysSection";
import ProjectMembersSection from "@/components/projects/ProjectMembersSection";
import ProjectSettingsSidebar, { ProjectSettingsTab } from "@/components/projects/ProjectSettingsSidebar";

interface ProjectSettingsContentProps {
  projectSlug: string;
  initialTab?: ProjectSettingsTab;
}

interface ProjectInfo {
  id: string;
  name: string;
  slug: string;
  description: string;
  created_at: string;
  updated_at: string;
}

interface ToastState {
  type: "success" | "error";
  message: string;
}

export default function ProjectSettingsContent({
  projectSlug,
  initialTab = "general"
}: ProjectSettingsContentProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<ProjectSettingsTab>(initialTab);
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [accessError, setAccessError] = useState<"notfound" | "forbidden" | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [copiedSlug, setCopiedSlug] = useState(false);

  const [formData, setFormData] = useState({
    name: "",
    description: "",
  });

  const showToast = (type: "success" | "error", message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 5000);
  };

  const handleCopySlug = async () => {
    if (!project?.slug) return;

    try {
      await navigator.clipboard.writeText(project.slug);
      setCopiedSlug(true);
      window.setTimeout(() => setCopiedSlug(false), 1600);
    } catch {
      showToast("error", "Failed to copy slug. Copy it manually.");
    }
  };

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    async function fetchProject() {
      try {
        const res = await fetch(`/api/projects/${projectSlug}`);
        if (!res.ok) {
          // 403 = the project exists but the caller isn't a member (e.g. they
          // were just removed). 404 = no such project. Show the matching
          // friendly state instead of a console error.
          if (res.status === 403) {
            setAccessError("forbidden");
            return;
          }
          if (res.status === 404) {
            setAccessError("notfound");
            return;
          }
          throw new Error("Failed to fetch project");
        }
        const data: ProjectInfo = await res.json();
        setProject(data);
        setFormData({
          name: data.name,
          description: data.description || "",
        });
      } catch (err) {
        console.error(err);
        showToast("error", err instanceof Error ? err.message : "Failed to fetch project");
      } finally {
        setIsLoading(false);
      }
    }
    fetchProject();
  }, [projectSlug]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);

    try {
      const res = await fetch(`/api/projects/${projectSlug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to update project");
      }

      const updated: ProjectInfo = await res.json();
      setProject(updated);
      showToast("success", "Project updated successfully");

      // Redirect if slug changed
      if (updated.slug !== projectSlug) {
        setTimeout(() => {
          router.push(`/projects/${updated.slug}/settings/${activeTab}`);
        }, 1000);
      }
    } catch (err) {
      console.error(err);
      showToast("error", err instanceof Error ? err.message : "Failed to update project");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm("Are you sure you want to delete this project? This action cannot be undone.")) {
      return;
    }

    setIsDeleting(true);

    try {
      const res = await fetch(`/api/projects/${projectSlug}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to delete project");
      }

      router.push("/projects");
    } catch (err) {
      console.error(err);
      showToast("error", err instanceof Error ? err.message : "Failed to delete project");
      setIsDeleting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="settings-page">
        <div className="settings-page-loading">
          <Loader2 size={24} className="animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (accessError) {
    const isForbidden = accessError === "forbidden";
    return (
      <div className="settings-page">
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-24 text-center">
          <div className="flex size-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
            {isForbidden ? <Lock size={26} strokeWidth={1.5} /> : <SearchX size={26} strokeWidth={1.5} />}
          </div>
          <h2 className="text-lg font-semibold text-foreground">
            {isForbidden ? "You don't have access" : "Project not found"}
          </h2>
          <p className="max-w-sm text-[13px] leading-relaxed text-muted-foreground">
            {isForbidden
              ? "You're not a member of this project. If you think this is a mistake, ask the project owner to invite you."
              : "This project doesn't exist, or it may have been deleted."}
          </p>
          <Button className="mt-2" onClick={() => router.push("/projects")}>
            Back to Projects
          </Button>
        </div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="settings-page">
        <div className="py-12 text-center text-sm text-muted-foreground">Project not found</div>
      </div>
    );
  }

  return (
    <div className="settings-page">
      {toast && (
        <div className="fixed bottom-6 left-1/2 z-[300] flex -translate-x-1/2 items-center gap-2.5 rounded-lg border border-border bg-card px-4 py-3 text-sm text-foreground shadow-lg animate-in fade-in-0 slide-in-from-bottom-2">
          <div
            className={cn(
              "flex items-center justify-center",
              toast.type === "success" ? "text-success" : "text-destructive",
            )}
          >
            {toast.type === "success" ? <Check size={16} /> : <X size={16} />}
          </div>
          <span>{toast.message}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            className="ml-1 text-muted-foreground hover:text-foreground"
            onClick={() => setToast(null)}
          >
            <X size={14} />
          </Button>
        </div>
      )}

      <div className="settings-page-body">
        <ProjectSettingsSidebar projectSlug={projectSlug} activeTab={activeTab} />

        <div className="settings-page-content">
          {activeTab === "general" && (
            <div className="settings-section-content">
              <SettingsCard title="General" description="Update your project details">
                <form onSubmit={handleSave} className="flex flex-col gap-4">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="project-slug" className="text-[13px]">
                      Project slug
                    </Label>
                    <div className="flex items-stretch justify-between gap-2.5">
                      <div
                        id="project-slug"
                        className="flex min-h-9 min-w-0 flex-1 items-center rounded-md border border-border bg-muted/50 px-3.5"
                        aria-readonly="true"
                      >
                        <code className="truncate font-mono text-[13px] text-foreground">{project.slug}</code>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-auto shrink-0"
                        onClick={handleCopySlug}
                      >
                        {copiedSlug ? <Check size={14} /> : <Copy size={14} />}
                        {copiedSlug ? "Copied" : "Copy"}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Use this exact value as{" "}
                      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">project_slug</code>{" "}
                      in SDK setup.
                    </p>
                  </div>

                  <div className="flex flex-col gap-2">
                    <Label htmlFor="name" className="text-[13px]">
                      Project Name
                    </Label>
                    <Input
                      id="name"
                      type="text"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      className="text-[13px]"
                      required
                    />
                  </div>

                  <div className="flex flex-col gap-2">
                    <Label htmlFor="description" className="text-[13px]">
                      Description
                    </Label>
                    <Textarea
                      id="description"
                      value={formData.description}
                      onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                      className="text-[13px]"
                      rows={3}
                      placeholder="Add a description for your project"
                    />
                  </div>

                  <div className="flex justify-end pt-1">
                    <Button type="submit" disabled={isSaving}>
                      {isSaving ? (
                        <>
                          <Loader2 size={14} className="animate-spin" />
                          Saving...
                        </>
                      ) : (
                        "Save changes"
                      )}
                    </Button>
                  </div>
                </form>
              </SettingsCard>

              <SettingsCard
                title="Danger Zone"
                description="Deleting a project will permanently remove it and all associated apps, API keys, and data. This action cannot be undone."
                variant="danger"
              >
                <Button
                  type="button"
                  variant="destructive"
                  onClick={handleDelete}
                  disabled={isDeleting}
                >
                  {isDeleting ? (
                    <>
                      <Loader2 size={16} className="animate-spin" />
                      Deleting...
                    </>
                  ) : (
                    <>
                      <Trash2 size={16} />
                      Delete Project
                    </>
                  )}
                </Button>
              </SettingsCard>
            </div>
          )}

          {activeTab === "members" && (
            <div className="settings-section-content">
              <ProjectMembersSection projectSlug={projectSlug} showToast={showToast} />
            </div>
          )}

          {activeTab === "api-keys" && (
            <div className="settings-section-content">
              <ProjectApiKeysSection projectSlug={projectSlug} showToast={showToast} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
