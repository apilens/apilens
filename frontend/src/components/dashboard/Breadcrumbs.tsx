"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { useApp } from "@/components/providers/AppProvider";

interface BreadcrumbsProps {
  appSlug?: string;
  projectSlug?: string;
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

export default function Breadcrumbs({ appSlug, projectSlug }: BreadcrumbsProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { app } = useApp();

  const parts = pathname.split("/").filter(Boolean);
  const [projectName, setProjectName] = useState<string>("");

  // For projects: /projects/[slug]/[section]
  // For apps: /apps/[slug]/[section]
  const isProject = parts[0] === "projects";
  const section = isProject ? parts[2] : parts[2];
  const sectionName = section ? (sectionMap[section] || section.charAt(0).toUpperCase() + section.slice(1)) : null;
  const displayName = isProject ? (projectName || projectSlug) : (app?.name || appSlug);
  const endpointId = section === "endpoints" && parts[3] && parts[3] !== "details" ? parts[3] : null;
  const [endpointLabel, setEndpointLabel] = useState<string>("Details");

  useEffect(() => {
    let cancelled = false;
    async function loadProjectName() {
      if (!projectSlug) return;
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
    async function loadEndpointLabel() {
      if (!endpointId || !appSlug) {
        setEndpointLabel("Details");
        return;
      }
      const params = new URLSearchParams();
      params.set("endpoint_id", endpointId);
      try {
        const res = await fetch(`/api/apps/${appSlug}/endpoint-meta?${params.toString()}`);
        if (!res.ok) {
          if (!cancelled) setEndpointLabel("Details");
          return;
        }
        const data = (await res.json()) as { method?: string; path?: string };
        const method = (data.method || "").toUpperCase();
        const path = data.path || "";
        if (!cancelled) setEndpointLabel(method && path ? `${method} ${path}` : path || "Details");
      } catch {
        if (!cancelled) setEndpointLabel("Details");
      }
    }
    loadEndpointLabel();
    return () => {
      cancelled = true;
    };
  }, [appSlug, endpointId]);

  let crumbs: Array<{ label: string; href?: string }> = [];

  if (isProject && projectSlug) {
    crumbs = [
      { label: "Projects", href: "/projects" },
      { label: displayName as string, href: `/projects/${projectSlug}/apps` },
    ];

    if (sectionName && section) {
      crumbs.push({ label: sectionName, href: `/projects/${projectSlug}/${section}` });
    }
  } else if (appSlug) {
    crumbs = [
      { label: "Apps", href: "/apps" },
      { label: displayName as string, href: `/apps/${appSlug}` },
    ];

    if (sectionName && section) {
      crumbs.push({ label: sectionName, href: `/apps/${appSlug}/${section}` });
    }

    if (section === "consumers" && parts[3]) {
      crumbs.push({ label: decodeURIComponent(parts[3]) });
    }

    if (section === "endpoints" && parts[3] === "details") {
      const method = searchParams.get("method");
      const path = searchParams.get("path");
      const detailLabel = method && path ? `${method.toUpperCase()} ${path}` : "Details";
      crumbs.push({ label: detailLabel });
    }
    if (section === "endpoints" && parts[3] && parts[3] !== "details") {
      crumbs.push({ label: endpointLabel });
    }
  }

  return (
    <nav className="breadcrumbs" aria-label="Breadcrumb">
      <ol className="breadcrumbs-list">
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1;
          return (
            <li key={`${crumb.label}-${index}`} className="breadcrumbs-item">
              {index > 0 && (
                <ChevronRight size={14} className="breadcrumbs-separator" />
              )}
              {crumb.href && !isLast ? (
                <Link
                  href={crumb.href}
                  className="breadcrumbs-link"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span className="breadcrumbs-current">{crumb.label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
