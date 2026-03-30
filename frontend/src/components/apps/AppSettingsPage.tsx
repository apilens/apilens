"use client";

import { useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { X, Check, ArrowLeft, Settings } from "lucide-react";
import { useApp } from "@/components/providers/AppProvider";
import AppSettingsSidebar, { AppSettingsTab } from "./AppSettingsSidebar";
import AppGeneralSection from "./AppGeneralSection";
import AppSetupGuide from "./AppSetupGuide";
import type { FrameworkId } from "@/types/app";

interface ToastState {
  type: "success" | "error";
  message: string;
}

interface AppSettingsPageProps {
  appSlug: string;
  projectSlug?: string;
  initialTab?: AppSettingsTab;
}

export default function AppSettingsPage({ appSlug, projectSlug, initialTab = "general" }: AppSettingsPageProps) {
  const router = useRouter();
  const activeTab = initialTab;
  const { app, isLoading } = useApp();
  const [localApp, setLocalApp] = useState(app);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [apiKeyPrefix, setApiKeyPrefix] = useState<string>("");

  useEffect(() => {
    setLocalApp(app);
  }, [app]);

  // Fetch PROJECT API key prefix for setup guide
  useEffect(() => {
    if (activeTab !== "setup" || !projectSlug) return;

    async function fetchApiKeys() {
      try {
        const res = await fetch(`/api/projects/${projectSlug}/api-keys`);
        if (res.ok) {
          const data = await res.json();
          if (data.keys && data.keys.length > 0) {
            setApiKeyPrefix(data.keys[0].prefix);
          }
        }
      } catch (err) {
        console.error("Failed to fetch project API keys:", err);
      }
    }

    fetchApiKeys();
  }, [activeTab, projectSlug]);

  const showToast = useCallback((type: "success" | "error", message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 5000);
  }, []);

  const handleUpdateApp = async (data: {
    name?: string;
    description?: string;
    framework?: FrameworkId;
  }) => {
    try {
      const url = projectSlug
        ? `/api/projects/${projectSlug}/apps/${appSlug}`
        : `/api/apps/${appSlug}`;
      const res = await fetch(url, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      if (!res.ok) {
        const result = await res.json();
        throw new Error(result.error || "Failed to update app");
      }

      const updated = await res.json();
      setLocalApp(updated);
      showToast("success", "App updated successfully");

      if (updated.slug && updated.slug !== appSlug) {
        const baseUrl = projectSlug
          ? `/projects/${projectSlug}/apps/${updated.slug}/settings`
          : `/apps/${updated.slug}/settings`;
        router.replace(`${baseUrl}/${activeTab}`);
      }
    } catch (error) {
      showToast("error", error instanceof Error ? error.message : "Failed to update app");
    }
  };

  const refreshApp = async () => {
    const url = projectSlug
      ? `/api/projects/${projectSlug}/apps/${appSlug}`
      : `/api/apps/${appSlug}`;
    const res = await fetch(url);
    if (!res.ok) return;
    const next = await res.json();
    setLocalApp(next);
  };

  const handleUploadAppIcon = async (file: Blob) => {
    try {
      const formData = new FormData();
      formData.append("file", file, "app-icon.jpg");
      const url = projectSlug
        ? `/api/projects/${projectSlug}/apps/${appSlug}/icon`
        : `/api/apps/${appSlug}/icon`;
      const res = await fetch(url, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to upload app icon");
      }
      await refreshApp();
      showToast("success", "App icon updated");
    } catch (error) {
      showToast("error", error instanceof Error ? error.message : "Failed to upload app icon");
    }
  };

  const handleRemoveAppIcon = async () => {
    try {
      const url = projectSlug
        ? `/api/projects/${projectSlug}/apps/${appSlug}/icon`
        : `/api/apps/${appSlug}/icon`;
      const res = await fetch(url, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to remove app icon");
      }
      await refreshApp();
      showToast("success", "App icon removed");
    } catch (error) {
      showToast("error", error instanceof Error ? error.message : "Failed to remove app icon");
    }
  };

  const handleDeleteApp = async () => {
    try {
      const url = projectSlug
        ? `/api/projects/${projectSlug}/apps/${appSlug}`
        : `/api/apps/${appSlug}`;
      const res = await fetch(url, {
        method: "DELETE",
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to delete app");
      }

      router.push(projectSlug ? `/projects/${projectSlug}` : "/apps");
    } catch (error) {
      showToast("error", error instanceof Error ? error.message : "Failed to delete app");
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

  if (!localApp) {
    return (
      <div className="settings-page">
        <div className="error-message">App not found</div>
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

      <div className="settings-page-header">
        {projectSlug && (
          <Link href={`/projects/${projectSlug}/apps`} className="settings-back-btn">
            <ArrowLeft size={16} />
            Back to Apps
          </Link>
        )}
        <div className="settings-page-title-wrap">
          <Settings size={20} />
          <h1 className="settings-page-title">
            {localApp.name} Settings
          </h1>
        </div>
        <p className="settings-page-subtitle">
          Manage this app's configuration and view setup instructions
        </p>
      </div>

      <div className="settings-page-body">
        <AppSettingsSidebar appSlug={appSlug} projectSlug={projectSlug} activeTab={activeTab} />

        <div className="settings-page-content">
          {activeTab === "general" && (
            <AppGeneralSection
              appSlug={appSlug}
              app={localApp}
              onUpdate={handleUpdateApp}
              onUploadIcon={handleUploadAppIcon}
              onRemoveIcon={handleRemoveAppIcon}
              onDelete={handleDeleteApp}
            />
          )}
          {activeTab === "setup" && localApp && projectSlug && (
            <div className="settings-section-content">
              <AppSetupGuide
                appName={localApp.name}
                framework={localApp.framework}
                apiKey={apiKeyPrefix ? `${apiKeyPrefix}********` : "Generate a project API key first"}
                hasRawKey={false}
                appSlug={appSlug}
                projectSlug={projectSlug}
                projectName={undefined}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
