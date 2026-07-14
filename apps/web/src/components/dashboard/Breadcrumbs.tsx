"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";

interface BreadcrumbsProps {
  projectSlug: string;
}

const sectionMap: Record<string, string> = {
  endpoints: "Endpoints",
  logs: "Logs",
  analytics: "Analytics",
  consumers: "Consumers",
  monitors: "Monitors",
  settings: "Settings",
  apps: "Apps",
};

export default function Breadcrumbs({ projectSlug }: BreadcrumbsProps) {
  const pathname = usePathname();

  const parts = pathname.split("/").filter(Boolean);
  const [projectName, setProjectName] = useState<string>("");

  // /projects/[slug]/[section], or /projects/[slug]/apps/[app_slug]/settings/[tab]
  const section = parts[2];
  const isAppSettings = section === "apps" && parts[3] && parts[4] === "settings";
  const appSlugFromPath = isAppSettings ? parts[3] : null;
  const sectionName = section ? (sectionMap[section] || section.charAt(0).toUpperCase() + section.slice(1)) : null;
  const displayName = projectName || projectSlug;
  const [appNameForSettings, setAppNameForSettings] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    async function loadProjectName() {
      try {
        const res = await fetch(`/api/projects/${projectSlug}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setProjectName(data.name || projectSlug);
      } catch {
        // ignore
      }
    }
    loadProjectName();
    return () => {
      cancelled = true;
    };
  }, [projectSlug]);

  useEffect(() => {
    let cancelled = false;
    async function loadAppName() {
      if (!isAppSettings || !appSlugFromPath) return;
      try {
        const res = await fetch(`/api/projects/${projectSlug}/apps/${appSlugFromPath}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setAppNameForSettings(data.name || appSlugFromPath);
      } catch {
        if (!cancelled) setAppNameForSettings(appSlugFromPath);
      }
    }
    loadAppName();
    return () => {
      cancelled = true;
    };
  }, [isAppSettings, projectSlug, appSlugFromPath]);

  const crumbs: Array<{ label: string; href?: string }> = [
    { label: "Projects", href: "/projects" },
    { label: displayName, href: `/projects/${projectSlug}/apps` },
  ];

  if (isAppSettings && appSlugFromPath) {
    // /projects/[slug]/apps/[app_slug]/settings/[tab]
    crumbs.push({ label: "Apps", href: `/projects/${projectSlug}/apps` });
    crumbs.push({ label: appNameForSettings || appSlugFromPath });
    crumbs.push({ label: "App Settings" });
  } else if (sectionName && section) {
    crumbs.push({ label: sectionName, href: `/projects/${projectSlug}/${section}` });
  }

  return (
    <nav className="flex items-center" aria-label="Breadcrumb">
      <ol className="m-0 flex list-none items-center gap-1.5 p-0">
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1;
          return (
            <li key={`${crumb.label}-${index}`} className="flex items-center gap-1.5">
              {index > 0 && (
                <ChevronRight size={14} className="shrink-0 text-muted-foreground" />
              )}
              {crumb.href && !isLast ? (
                <Link
                  href={crumb.href}
                  className="text-[13px] text-muted-foreground no-underline transition-colors hover:text-foreground"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span className="text-[13px] font-semibold text-foreground">{crumb.label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
