"use client";

import { useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import { X, Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/reui/button";
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
  projectSlug: string;
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
    if (activeTab !== "setup") return;

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
      const res = await fetch(`/api/projects/${projectSlug}/apps/${appSlug}`, {
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
        router.replace(`/projects/${projectSlug}/apps/${updated.slug}/settings/${activeTab}`);
      }
    } catch (error) {
      showToast("error", error instanceof Error ? error.message : "Failed to update app");
    }
  };

  const handleDeleteApp = async () => {
    try {
      const res = await fetch(`/api/projects/${projectSlug}/apps/${appSlug}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to delete app");
      }

      router.push(`/projects/${projectSlug}`);
    } catch (error) {
      showToast("error", error instanceof Error ? error.message : "Failed to delete app");
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

  if (!localApp) {
    return (
      <div className="settings-page">
        <div className="py-12 text-center text-sm text-muted-foreground">App not found</div>
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

      <div className="page-header">
        <h1 className="page-title">Settings</h1>
      </div>

      <div className="settings-page-body">
        <AppSettingsSidebar appSlug={appSlug} projectSlug={projectSlug} activeTab={activeTab} />

        <div className="settings-page-content">
          {activeTab === "general" && (
            <AppGeneralSection
              appSlug={appSlug}
              app={localApp}
              onUpdate={handleUpdateApp}
              onDelete={handleDeleteApp}
            />
          )}
          {activeTab === "setup" && localApp && (
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
