"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import AppSetupGuide from "@/components/apps/AppSetupGuide";
import type { FrameworkId } from "@/types/app";

interface SetupMeta {
  appName: string;
  framework: FrameworkId;
  apiKeyPrefix: string;
  projectSlug: string;
  projectName?: string;
  createdAt: number;
}

export default function ProjectAppSetupPage() {
  const router = useRouter();
  const params = useParams();
  const projectSlug = params.slug as string;
  const appSlug = params.app_slug as string;

  const [meta, setMeta] = useState<SetupMeta | null>(null);
  const [projectName, setProjectName] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const metaKey = `apilens_setup_meta_${appSlug}`;
    const rawMeta = window.localStorage.getItem(metaKey);

    if (rawMeta) {
      try {
        setMeta(JSON.parse(rawMeta));
      } catch {
        // ignore
      }
    }

    setLoading(false);
  }, [appSlug]);

  useEffect(() => {
    let cancelled = false;

    async function loadProjectName() {
      if (!projectSlug) return;
      try {
        const res = await fetch(`/api/projects/${projectSlug}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) {
          setProjectName(data.name || projectSlug);
        }
      } catch {
        if (!cancelled) {
          setProjectName("");
        }
      }
    }

    loadProjectName();
    return () => {
      cancelled = true;
    };
  }, [projectSlug]);

  if (loading) {
    return (
      <div style={{ padding: "32px", textAlign: "center" }}>
        <p>Loading setup guide...</p>
      </div>
    );
  }

  if (!meta) {
    router.push(`/projects/${projectSlug}`);
    return null;
  }

  return (
    <div className="create-app-container">
      <AppSetupGuide
        appName={meta.appName}
        framework={meta.framework}
        apiKey={`${meta.apiKeyPrefix}********`}
        hasRawKey={false}
        appSlug={appSlug}
        projectSlug={projectSlug}
        projectName={projectName || meta.projectName}
      />
    </div>
  );
}
