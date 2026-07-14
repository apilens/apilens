"use client";

import Link from "next/link";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/components/providers/AuthProvider";
import Navbar from "./Navbar";

interface StandaloneShellProps {
  children: React.ReactNode;
}

export default function StandaloneShell({ children }: StandaloneShellProps) {
  const { isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 text-muted-foreground">
        <Loader2 size={24} className="animate-spin" />
        <p className="text-sm">Loading...</p>
      </div>
    );
  }

  return (
    // `.standalone-layout` / `.standalone-topbar` / `.standalone-content` stay:
    // they are layout-contract classes (`.standalone-topbar .navbar` restyles
    // the nested Navbar chrome).
    <div className="standalone-layout">
      <header className="standalone-topbar">
        <div className="flex items-center gap-5">
          <Link href="/projects" className="flex items-center no-underline">
            <span className="text-lg font-bold tracking-tight text-foreground">API Lens</span>
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
