"use client";

import { createContext, useContext, useEffect, useState } from "react";

interface SidebarContextType {
  collapsed: boolean;
  toggleSidebar: () => void;
}

const SidebarContext = createContext<SidebarContextType | undefined>(undefined);

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const stored = localStorage.getItem("sidebar-collapsed");
    if (stored === "true") {
      setCollapsed(true);
    }
  }, []);

  useEffect(() => {
    if (mounted) {
      localStorage.setItem("sidebar-collapsed", String(collapsed));
    }
  }, [collapsed, mounted]);

  const toggleSidebar = () => {
    setCollapsed((prev) => !prev);
  };

  return (
    <SidebarContext.Provider value={{ collapsed, toggleSidebar }}>
      {children}
    </SidebarContext.Provider>
  );
}

export function useSidebar() {
  const context = useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider");
  }
  return context;
}
