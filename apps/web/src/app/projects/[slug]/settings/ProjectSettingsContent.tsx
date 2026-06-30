"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Loader2, X, Check, Copy, Lock, SearchX } from "lucide-react";
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
          <div className="loading-spinner" />
        </div>
      </div>
    );
  }

  if (accessError) {
    const isForbidden = accessError === "forbidden";
    return (
      <div className="settings-page">
        <div className="settings-noaccess">
          <div className="settings-noaccess-icon">
            {isForbidden ? <Lock size={26} strokeWidth={1.5} /> : <SearchX size={26} strokeWidth={1.5} />}
          </div>
          <h2 className="settings-noaccess-title">
            {isForbidden ? "You don't have access" : "Project not found"}
          </h2>
          <p className="settings-noaccess-text">
            {isForbidden
              ? "You're not a member of this project. If you think this is a mistake, ask the project owner to invite you."
              : "This project doesn't exist, or it may have been deleted."}
          </p>
          <button
            className="settings-btn settings-btn-primary"
            onClick={() => router.push("/projects")}
          >
            Back to Projects
          </button>
        </div>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="settings-page">
        <div className="error-message">Project not found</div>
      </div>
    );
  }

  return (
    <div className="settings-page">
      {toast && (
        <div className={`settings-toast settings-toast-${toast.type}`}>
          <div className="settings-toast-icon">
            {toast.type === "success" ? <Check size={16} /> : <X size={16} />}
          </div>
          <span>{toast.message}</span>
          <button className="settings-toast-close" onClick={() => setToast(null)}>
            <X size={14} />
          </button>
        </div>
      )}

      <div className="settings-page-body">
        <ProjectSettingsSidebar projectSlug={projectSlug} activeTab={activeTab} />

        <div className="settings-page-content">
          {activeTab === "general" && (
            <div className="settings-section-content">
              <SettingsCard title="General" description="Update your project details">
                <form onSubmit={handleSave} className="app-general-form">
                  <div className="create-app-field">
                    <label htmlFor="project-slug" className="create-app-label">
                      Project slug
                    </label>
                    <div className="settings-inline-field">
                      <div id="project-slug" className="settings-inline-value" aria-readonly="true">
                        <code className="settings-inline-code">{project.slug}</code>
                      </div>
                      <button
                        type="button"
                        className="settings-btn settings-btn-secondary settings-btn-sm settings-inline-action"
                        onClick={handleCopySlug}
                      >
                        {copiedSlug ? <Check size={14} /> : <Copy size={14} />}
                        {copiedSlug ? "Copied" : "Copy"}
                      </button>
                    </div>
                    <p className="settings-inline-help">Use this exact value as <code>project_slug</code> in SDK setup.</p>
                  </div>

                  <div className="create-app-field">
                    <label htmlFor="name" className="create-app-label">
                      Project Name
                    </label>
                    <input
                      id="name"
                      type="text"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      className="create-app-input"
                      required
                    />
                  </div>

                  <div className="create-app-field">
                    <label htmlFor="description" className="create-app-label">
                      Description
                    </label>
                    <textarea
                      id="description"
                      value={formData.description}
                      onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                      className="create-app-textarea"
                      rows={3}
                      placeholder="Add a description for your project"
                    />
                  </div>

                  <div className="app-general-actions">
                    <button type="submit" className="settings-btn settings-btn-primary" disabled={isSaving}>
                      {isSaving ? (
                        <>
                          <Loader2 size={14} className="animate-spin" />
                          Saving...
                        </>
                      ) : (
                        "Save changes"
                      )}
                    </button>
                  </div>
                </form>
              </SettingsCard>

              <SettingsCard
                title="Danger Zone"
                description="Deleting a project will permanently remove it and all associated apps, API keys, and data. This action cannot be undone."
                variant="danger"
              >
                <button
                  type="button"
                  onClick={handleDelete}
                  className="settings-btn settings-btn-danger"
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
                </button>
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
