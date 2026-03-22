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
  createdAt: number;
}

export default function ProjectAppSetupPage() {
  const router = useRouter();
  const params = useParams();
  const projectSlug = params.slug as string;
  const appSlug = params.app_slug as string;

  const [meta, setMeta] = useState<SetupMeta | null>(null);
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
      />
    </div>
  );
}
