"use client";

import Link from "next/link";
import { useAuth } from "@/components/providers/AuthProvider";
import Navbar from "./Navbar";

interface AccountLayoutProps {
  children: React.ReactNode;
}

export default function AccountLayout({ children }: AccountLayoutProps) {
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
    <div className="account-layout">
      <header className="account-topbar">
        <Link href="/" className="account-logo">
          <span className="account-logo-text">API Lens</span>
        </Link>
        <Navbar />
      </header>
      <main className="account-content">
        {children}
      </main>
    </div>
  );
}
