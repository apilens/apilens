"use client";

import { useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { X, Check } from "lucide-react";
import { useApp } from "@/components/providers/AppProvider";
import PageHeader from "@/components/dashboard/PageHeader";
import AppSettingsSidebar, { AppSettingsTab } from "./AppSettingsSidebar";
import AppGeneralSection from "./AppGeneralSection";
import AppApiKeysSection from "./AppApiKeysSection";

interface ToastState {
  type: "success" | "error";
  message: string;
}

interface AppSettingsPageProps {
  appSlug: string;
  initialTab?: AppSettingsTab;
}

export default function AppSettingsPage({ appSlug, initialTab = "general" }: AppSettingsPageProps) {
  const router = useRouter();
  const activeTab = initialTab;
  const { app, isLoading } = useApp();
  const [localApp, setLocalApp] = useState(app);
  const [toast, setToast] = useState<ToastState | null>(null);

  useEffect(() => {
    setLocalApp(app);
  }, [app]);

  const showToast = useCallback((type: "success" | "error", message: string) => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 5000);
  }, []);

  const handleUpdateApp = async (data: {
    name?: string;
    description?: string;
    framework?: "fastapi" | "flask" | "django" | "starlette";
  }) => {
    try {
      const res = await fetch(`/api/apps/${appSlug}`, {
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
        router.replace(`/apps/${updated.slug}/settings/${activeTab}`);
      }
    } catch (error) {
      showToast("error", error instanceof Error ? error.message : "Failed to update app");
    }
  };

  const refreshApp = async () => {
    const res = await fetch(`/api/apps/${appSlug}`);
    if (!res.ok) return;
    const next = await res.json();
    setLocalApp(next);
  };

  const handleUploadAppIcon = async (file: Blob) => {
    try {
      const formData = new FormData();
      formData.append("file", file, "app-icon.jpg");
      const res = await fetch(`/api/apps/${appSlug}/icon`, {
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
      const res = await fetch(`/api/apps/${appSlug}/icon`, { method: "DELETE" });
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
      const res = await fetch(`/api/apps/${appSlug}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to delete app");
      }

      router.push("/apps");
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
        <PageHeader title="App not found" />
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

      <PageHeader title="Settings" />

      <div className="settings-page-body">
        <AppSettingsSidebar appSlug={appSlug} activeTab={activeTab} />

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
          {activeTab === "api-keys" && (
            <div className="settings-section-content">
              <AppApiKeysSection appSlug={appSlug} showToast={showToast} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
