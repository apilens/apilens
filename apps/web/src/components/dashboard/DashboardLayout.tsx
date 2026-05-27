"use client";

import { useAuth } from "@/components/providers/AuthProvider";
import { OptionalAppProvider } from "@/components/providers/AppProvider";
import { SidebarProvider, useSidebar } from "@/components/providers/SidebarProvider";
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
      <div className="loading-screen">
        <div className="loading-spinner" />
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <div className="dashboard-container">
      <Sidebar />
      <div className={`main-wrapper ${collapsed ? "main-wrapper-expanded" : ""}`}>
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
