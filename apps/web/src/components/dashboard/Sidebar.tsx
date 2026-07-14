"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname, useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import {
  Layers,
  LayoutGrid,
  ScrollText,
  Activity,
  AlertOctagon,
  Users,
  Settings,
  Bell,
  CircleHelpIcon,
  PanelLeftClose,
  PanelLeft,
  ChevronsUpDown,
  Plus,
  Check,
} from "lucide-react";
import { useSidebar } from "@/components/providers/SidebarProvider";
import { cn } from "@/lib/utils";
import { Button } from "@/components/reui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/reui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/reui/tooltip";

interface ProjectListItem {
  id: string;
  name: string;
  slug: string;
}

interface NavEntry {
  name: string;
  href: string;
  icon: typeof Layers;
}

function NavItem({
  item,
  isActive,
  collapsed,
}: {
  item: NavEntry;
  isActive: boolean;
  collapsed: boolean;
}) {
  const link = (
    <Link
      href={item.href}
      className={cn(
        "flex h-8 items-center gap-3 rounded-md px-3 text-[13px] font-medium text-muted-foreground transition-colors",
        "hover:bg-accent hover:text-foreground",
        isActive && "bg-primary/10 font-semibold text-foreground",
        collapsed && "justify-center px-0",
      )}
    >
      <item.icon
        size={16}
        className={cn(
          "shrink-0 opacity-60 [stroke-width:1.75]",
          isActive && "text-primary opacity-100",
        )}
      />
      {!collapsed && <span>{item.name}</span>}
    </Link>
  );

  if (!collapsed) return link;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{item.name}</TooltipContent>
    </Tooltip>
  );
}

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { collapsed, toggleSidebar } = useSidebar();

  const parts = pathname.split("/").filter(Boolean);
  const inProject = parts[0] === "projects" && parts[1];
  const projectSlug = inProject ? parts[1] : "";

  const [projects, setProjects] = useState<ProjectListItem[]>([]);

  useEffect(() => {
    async function fetchProjects() {
      try {
        const res = await fetch("/api/projects");
        if (res.ok) {
          const data = await res.json();
          setProjects(data.projects || []);
        }
      } catch {
        // ignore
      }
    }
    fetchProjects();
  }, []);

  const navigation: NavEntry[] = inProject
    ? [
        { name: "Apps", href: `/projects/${projectSlug}/apps`, icon: LayoutGrid },
        { name: "Traffic", href: `/projects/${projectSlug}/traffic`, icon: Activity },
        { name: "Errors", href: `/projects/${projectSlug}/errors`, icon: AlertOctagon },
        { name: "Request logs", href: `/projects/${projectSlug}/endpoints`, icon: ScrollText },
        { name: "Consumers", href: `/projects/${projectSlug}/consumers`, icon: Users },
        { name: "Settings", href: `/projects/${projectSlug}/settings`, icon: Settings },
      ]
    : [
        { name: "Projects", href: "/projects", icon: Layers },
        { name: "Create Project", href: "/projects/new", icon: Plus },
        { name: "Account", href: "/settings/general", icon: Settings },
      ];

  const secondaryNavigation: NavEntry[] = [
    { name: "Notifications", href: "/notifications", icon: Bell },
    { name: "Help & Support", href: "/help", icon: CircleHelpIcon },
  ];

  const currentProject = projects.find((p) => p.slug === projectSlug);
  const displayName = currentProject?.name || (inProject ? projectSlug : "Select project");
  const currentAvatar = (displayName?.charAt(0) || "P").toUpperCase().slice(0, 2);

  return (
    <aside className={cn("sidebar", collapsed && "sidebar-collapsed")}>
      <div className="sidebar-header">
        <Link href="/projects" className="logo" title="Back to Projects">
          {collapsed ? (
            <Image
              src="/logo.svg"
              alt="APILens"
              width={28}
              height={28}
              className="logo-icon-collapsed"
            />
          ) : (
            <span className="logo-text">APILens</span>
          )}
        </Link>
      </div>

      {/* Project Switcher */}
      <div className={cn("border-b border-border p-3", collapsed && "px-2")}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              className={cn(
                "h-9 w-full justify-start gap-2 px-2 text-[13px] font-semibold",
                collapsed && "justify-center px-0",
              )}
              title={collapsed ? displayName : undefined}
            >
              <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/15 text-[11px] font-bold text-primary">
                {currentAvatar}
              </span>
              {!collapsed && (
                <>
                  <span className="min-w-0 flex-1 truncate text-left">{displayName}</span>
                  <ChevronsUpDown size={14} className="shrink-0 text-muted-foreground" />
                </>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60">
            <DropdownMenuLabel className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Projects
            </DropdownMenuLabel>
            {projects.map((project) => {
              const isActive = project.slug === projectSlug;
              return (
                <DropdownMenuItem
                  key={project.id}
                  onSelect={() => router.push(`/projects/${project.slug}/apps`)}
                  className="gap-2"
                >
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/15 text-[11px] font-bold text-primary">
                    {(project.name.charAt(0) || "P").toUpperCase().slice(0, 2)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  {isActive && <Check size={14} className="text-primary" />}
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link href="/projects" className="gap-2">
                <Layers size={14} />
                <span>View all projects</span>
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/projects/new" className="gap-2">
                <Plus size={14} />
                <span>Create project</span>
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <nav className="flex flex-1 flex-col gap-6 overflow-y-auto px-3 py-4">
        <ul className="flex flex-col gap-0.5">
          {navigation.map((item) => (
            <li key={item.name}>
              <NavItem
                item={item}
                collapsed={collapsed}
                isActive={pathname === item.href || pathname.startsWith(item.href + "/")}
              />
            </li>
          ))}
        </ul>

        {/* Secondary links pinned to the bottom of the rail. */}
        <ul className="mt-auto flex flex-col gap-0.5">
          {secondaryNavigation.map((item) => (
            <li key={item.name}>
              <NavItem
                item={item}
                collapsed={collapsed}
                isActive={pathname === item.href || pathname.startsWith(item.href + "/")}
              />
            </li>
          ))}
        </ul>
      </nav>

      <div className="border-t border-border p-3">
        <Button
          variant="ghost"
          onClick={toggleSidebar}
          className={cn(
            "h-8 w-full justify-start gap-3 px-3 text-[13px] text-muted-foreground",
            collapsed && "justify-center px-0",
          )}
          title={collapsed ? "Expand Sidebar" : "Collapse Sidebar"}
        >
          {collapsed ? <PanelLeft size={16} /> : <PanelLeftClose size={16} />}
          {!collapsed && <span>Collapse</span>}
        </Button>
      </div>
    </aside>
  );
}
