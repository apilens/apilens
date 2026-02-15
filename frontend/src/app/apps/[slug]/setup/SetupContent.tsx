"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import AppSetupGuide from "@/components/apps/AppSetupGuide";

type FrameworkId = "fastapi" | "flask" | "django" | "starlette";

type SetupMeta = {
  appName: string;
  framework: FrameworkId;
  apiKeyPrefix?: string;
  createdAt: number;
};

type SetupSecret = {
  appName?: string;
  framework?: FrameworkId;
  apiKey?: string;
  createdAt?: number;
};

type SetupBootstrap = {
  appName: string;
  framework: FrameworkId;
  apiKey: string;
  hasRawKey: boolean;
  createdAt: number;
};

export default function SetupContent({ appSlug }: { appSlug: string }) {
  const [data, setData] = useState<SetupBootstrap | null>(null);

  useEffect(() => {
    let mounted = true;

    const readJson = <T,>(raw: string | null): T | null => {
      if (!raw) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    };

    const buildMaskedKey = (prefix?: string): string =>
      prefix ? `${prefix}********` : "APILENS_API_KEY_HERE";

    const hydrate = async () => {
      const metaKey = `apilens_setup_meta_${appSlug}`;
      const secretKey = `apilens_setup_secret_${appSlug}`;
      const legacyKey = `apilens_setup_${appSlug}`;

      const meta = readJson<SetupMeta>(window.localStorage.getItem(metaKey));
      let appName = meta?.appName || "Your app";
      let framework: FrameworkId = meta?.framework || "fastapi";
      let apiKey = buildMaskedKey(meta?.apiKeyPrefix);
      let hasRawKey = false;
      let createdAt = meta?.createdAt || Date.now();

      const secret =
        readJson<SetupSecret>(window.sessionStorage.getItem(secretKey)) ||
        readJson<SetupSecret>(window.sessionStorage.getItem(legacyKey));

      if (secret?.apiKey) {
        hasRawKey = true;
        apiKey = secret.apiKey;
        appName = secret.appName || appName;
        framework = secret.framework || framework;
        createdAt = secret.createdAt || createdAt;
      }

      // Consume one-time secret immediately.
      window.sessionStorage.removeItem(secretKey);
      window.sessionStorage.removeItem(legacyKey);

      if (!meta) {
        try {
          const res = await fetch(`/api/apps/${appSlug}`);
          if (res.ok) {
            const app = await res.json();
            appName = app?.name || appName;
          }
        } catch {
          // ignore network errors; show fallback setup
        }
      }

      // Persist non-sensitive metadata if missing (for future refreshes).
      if (!meta) {
        window.localStorage.setItem(
          metaKey,
          JSON.stringify({
            appName,
            framework,
            createdAt,
          } satisfies SetupMeta),
        );
      }

      if (!mounted) return;
      setData({
        appName,
        framework,
        apiKey,
        hasRawKey,
        createdAt,
      });
    };

    void hydrate();

    return () => {
      mounted = false;
    };
  }, [appSlug]);

  if (!data) {
    return <div className="create-app-page">Loading setup...</div>;
  }

  return (
    <div className="create-app-page create-app-page-wide">
      <AppSetupGuide
        appName={data.appName}
        framework={data.framework}
        apiKey={data.apiKey}
        hasRawKey={data.hasRawKey}
        appSlug={appSlug}
      />
      {!data.hasRawKey ? (
        <div className="create-app-warning create-app-warning-inline">
          Raw API key is hidden after first view. Create a new key from{" "}
          <Link href={`/apps/${appSlug}/settings/api-keys`}>API keys</Link> and update the snippet.
        </div>
      ) : null}
    </div>
  );
}
