"use client";

import { useAuth } from "@/components/providers/AuthProvider";
import { OptionalAppProvider } from "@/components/providers/AppProvider";
import { SidebarProvider, useSidebar } from "@/components/providers/SidebarProvider";
import Sidebar from "./Sidebar";
import Navbar from "./Navbar";

interface DashboardLayoutProps {
  children: React.ReactNode;
  appSlug?: string;
}

function DashboardInner({ children, appSlug }: DashboardLayoutProps) {
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
      <Sidebar appSlug={appSlug} />
      <div className={`main-wrapper ${collapsed ? "main-wrapper-expanded" : ""}`}>
        <Navbar appSlug={appSlug} />
        <main className="main-content">
          {children}
        </main>
      </div>
    </div>
  );
}

export default function DashboardLayout({ children, appSlug }: DashboardLayoutProps) {
  return (
    <SidebarProvider>
      <OptionalAppProvider appSlug={appSlug}>
        <DashboardInner appSlug={appSlug}>{children}</DashboardInner>
      </OptionalAppProvider>
    </SidebarProvider>
  );
}
