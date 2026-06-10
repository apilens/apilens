"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import Spotlight from "@/components/aperture/Spotlight";

interface SpotlightContextType {
  open: boolean;
  openSpotlight: () => void;
  closeSpotlight: () => void;
  toggleSpotlight: () => void;
}

const SpotlightContext = createContext<SpotlightContextType | undefined>(undefined);

export function SpotlightProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  const openSpotlight = useCallback(() => setOpen(true), []);
  const closeSpotlight = useCallback(() => setOpen(false), []);
  const toggleSpotlight = useCallback(() => setOpen((v) => !v), []);

  // Global ⌘K / Ctrl+K — the Command principle.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <SpotlightContext.Provider value={{ open, openSpotlight, closeSpotlight, toggleSpotlight }}>
      {children}
      <Spotlight open={open} onClose={closeSpotlight} />
    </SpotlightContext.Provider>
  );
}

export function useSpotlight() {
  const ctx = useContext(SpotlightContext);
  if (!ctx) throw new Error("useSpotlight must be used within a SpotlightProvider");
  return ctx;
}
