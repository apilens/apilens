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

export function AppProvider({ appSlug, children }: { appSlug: string; children: React.ReactNode }) {
  const [app, setApp] = useState<App | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/apps/${appSlug}`);
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
  }, [appSlug]);

  return (
    <AppContext.Provider value={{ app, isLoading }}>
      {children}
    </AppContext.Provider>
  );
}

export function OptionalAppProvider({
  appSlug,
  children,
}: {
  appSlug?: string;
  children: React.ReactNode;
}) {
  if (!appSlug) {
    return (
      <AppContext.Provider value={{ app: null, isLoading: false }}>
        {children}
      </AppContext.Provider>
    );
  }
  return <AppProvider appSlug={appSlug}>{children}</AppProvider>;
}
