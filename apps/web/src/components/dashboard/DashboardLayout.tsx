"use client";

import { Loader2 } from "lucide-react";
import { useAuth } from "@/components/providers/AuthProvider";
import { OptionalAppProvider } from "@/components/providers/AppProvider";
import { SidebarProvider, useSidebar } from "@/components/providers/SidebarProvider";
import { cn } from "@/lib/utils";
import Sidebar from "./Sidebar";
import Navbar from "./Navbar";

interface DashboardLayoutProps {
  children: React.ReactNode;
  projectSlug?: string;
}

function DashboardInner({ children, projectSlug }: DashboardLayoutProps) {
  const { isLoading } = useAuth();
  const { collapsed } = useSidebar();

  if (isLoading) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 text-muted-foreground">
        <Loader2 size={24} className="animate-spin" />
        <p className="text-sm">Loading...</p>
      </div>
    );
  }

  return (
    // `.dashboard-container` / `.main-wrapper` / `.main-content` are
    // layout-contract classes — keep them.
    <div className="dashboard-container">
      <Sidebar />
      <div className={cn("main-wrapper", collapsed && "main-wrapper-expanded")}>
        <Navbar projectSlug={projectSlug} />
        <main className="main-content">
          {children}
        </main>
      </div>
    </div>
  );
}

export default function DashboardLayout({ children, projectSlug }: DashboardLayoutProps) {
  return (
    <SidebarProvider>
      <OptionalAppProvider>
        <DashboardInner projectSlug={projectSlug}>{children}</DashboardInner>
      </OptionalAppProvider>
    </SidebarProvider>
  );
}
