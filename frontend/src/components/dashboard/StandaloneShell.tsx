"use client";

import Link from "next/link";
import { useAuth } from "@/components/providers/AuthProvider";
import Navbar from "./Navbar";

interface StandaloneShellProps {
  children: React.ReactNode;
}

export default function StandaloneShell({ children }: StandaloneShellProps) {
  const { isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="loading-screen">
        <div className="loading-spinner" />
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <div className="standalone-layout">
      <header className="standalone-topbar">
        <div className="standalone-topbar-left">
          <Link href="/projects" className="standalone-logo">
            <span className="standalone-logo-text">API Lens</span>
          </Link>
        </div>
        <Navbar />
      </header>
      <main className="standalone-content">
        {children}
      </main>
    </div>
  );
}
