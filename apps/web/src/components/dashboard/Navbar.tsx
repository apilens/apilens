"use client";

import { useAuth } from "@/components/providers/AuthProvider";
import { useSpotlight } from "@/components/providers/SpotlightProvider";
import UserAvatar from "@/components/shared/UserAvatar";
import Breadcrumbs from "./Breadcrumbs";
import NotificationsBell from "./NotificationsBell";
import { LogOut, Search, Settings } from "lucide-react";
import Link from "next/link";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/reui/dropdown-menu";

export interface NavbarProps {
  projectSlug?: string;
}

export default function Navbar({ projectSlug }: NavbarProps) {
  const { user, isLoading, logout } = useAuth();
  const { openSpotlight } = useSpotlight();

  const displayName = user?.display_name || "";
  const displayEmail = user?.email || "";

  return (
    <header className="navbar">
      <div className="navbar-left">
        {projectSlug && <Breadcrumbs projectSlug={projectSlug} />}
      </div>

      <div className="navbar-right">
        <button
          type="button"
          className="flex h-8 items-center gap-2 rounded-md border border-border bg-muted/50 px-3 text-[13px] text-muted-foreground transition-colors hover:border-ring hover:text-foreground"
          onClick={openSpotlight}
          aria-label="Open Spotlight search"
        >
          <Search size={15} />
          <span className="pr-4">Search…</span>
          <kbd className="rounded border border-border bg-background px-1.5 py-0.5 font-sans text-[10px] font-semibold text-muted-foreground">
            ⌘K
          </kbd>
        </button>

        <NotificationsBell />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex items-center rounded-full outline-none transition-shadow focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Open user menu"
            >
              {!isLoading && user ? (
                <UserAvatar name={displayName} email={displayEmail} size="sm" />
              ) : (
                <div className="user-avatar-gradient" />
              )}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>
              <p className="text-[13px] font-semibold text-foreground">
                {displayName || displayEmail.split("@")[0]}
              </p>
              <p className="truncate text-xs font-normal text-muted-foreground">
                {displayEmail}
              </p>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/account" className="gap-2">
                <Settings size={14} />
                <span>Account Settings</span>
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => logout()} className="gap-2">
              <LogOut size={14} />
              <span>Logout</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
