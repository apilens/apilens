"use client";

import { createContext, useContext, useEffect, useState } from "react";
import type { App } from "@/types/app";

interface AppContextValue {
  app: App | null;
  isLoading: boolean;
}

const AppContext = createContext<AppContextValue>({ app: null, isLoading: true });

export function useApp() {
  return useContext(AppContext);
}

export function AppProvider({
  appSlug,
  projectSlug,
  children
}: {
  appSlug: string;
  projectSlug?: string;
  children: React.ReactNode;
}) {
  const [app, setApp] = useState<App | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        // Use project-scoped endpoint if projectSlug is provided, otherwise fall back to legacy endpoint
        const url = projectSlug
          ? `/api/projects/${projectSlug}/apps/${appSlug}`
          : `/api/apps/${appSlug}`;
        const res = await fetch(url);
        if (res.ok && !cancelled) {
          setApp(await res.json());
        }
      } catch {
        // fallback: app stays null, slug shown instead
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [appSlug, projectSlug]);

  return (
    <AppContext.Provider value={{ app, isLoading }}>
      {children}
    </AppContext.Provider>
  );
}

export function OptionalAppProvider({
  appSlug,
  projectSlug,
  children,
}: {
  appSlug?: string;
  projectSlug?: string;
  children: React.ReactNode;
}) {
  if (!appSlug) {
    return (
      <AppContext.Provider value={{ app: null, isLoading: false }}>
        {children}
      </AppContext.Provider>
    );
  }
  return <AppProvider appSlug={appSlug} projectSlug={projectSlug}>{children}</AppProvider>;
}
