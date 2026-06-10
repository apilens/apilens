"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import { Command } from "cmdk";
import {
  Activity,
  FolderKanban,
  Layers,
  Plus,
  Search,
  Settings,
  SunMoon,
} from "lucide-react";
import { useTheme } from "@/components/providers/ThemeProvider";

interface ProjectRow { slug: string; name: string }
interface AppRow { slug: string; name: string }
interface EndpointRow { method: string; path: string }

function currentProjectSlug(pathname: string | null): string | null {
  if (!pathname) return null;
  const m = pathname.match(/^\/projects\/([^/]+)/);
  return m && m[1] !== "new" ? m[1] : null;
}

/** Aperture Spotlight — ⌘K command palette. The Command principle made real. */
export default function Spotlight({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const { toggleTheme } = useTheme();
  const projectSlug = currentProjectSlug(pathname);

  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [apps, setApps] = useState<AppRow[]>([]);
  const [endpoints, setEndpoints] = useState<EndpointRow[]>([]);

  // Load index data once per open (cheap; cmdk does the fuzzy filtering).
  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch("/api/projects", { signal: ctrl.signal });
        if (res.ok) {
          const data = await res.json();
          const list = (data.projects || data.items || data || []) as ProjectRow[];
          setProjects(list.map((p) => ({ slug: p.slug, name: p.name })));
        }
      } catch { /* ignore */ }

      if (projectSlug) {
        try {
          const res = await fetch(`/api/projects/${projectSlug}/apps`, { signal: ctrl.signal });
          if (res.ok) {
            const data = await res.json();
            setApps(((data.apps || []) as AppRow[]).map((a) => ({ slug: a.slug, name: a.name })));
          }
        } catch { /* ignore */ }
        try {
          const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          const res = await fetch(
            `/api/projects/${projectSlug}/analytics/endpoints?since=${encodeURIComponent(since)}&page_size=50`,
            { signal: ctrl.signal },
          );
          if (res.ok) {
            const data = await res.json();
            const items = (data.items || data || []) as EndpointRow[];
            setEndpoints(items.map((e) => ({ method: e.method, path: e.path })));
          }
        } catch { /* ignore */ }
      }
    })();
    return () => ctrl.abort();
  }, [open, projectSlug]);

  // ⌘K-style: close on Escape handled by cmdk's `shouldFilter`; we add Escape here too.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const go = (href: string) => {
    onClose();
    router.push(href);
  };

  const actions = useMemo(
    () => [
      { label: "New project", icon: <Plus size={16} />, run: () => go("/projects/new") },
      ...(projectSlug
        ? [{ label: "Project settings", icon: <Settings size={16} />, run: () => go(`/projects/${projectSlug}/settings`) }]
        : []),
      { label: "Account settings", icon: <Settings size={16} />, run: () => go("/account/general") },
      { label: "Toggle light / dark", icon: <SunMoon size={16} />, run: () => { toggleTheme(); onClose(); } },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectSlug],
  );

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="ap-spotlight-overlay" onClick={onClose}>
      <div className="ap-spotlight" onClick={(e) => e.stopPropagation()}>
        <Command label="Spotlight" loop>
          <div className="ap-spotlight-input-row">
            <Search size={18} />
            <Command.Input autoFocus placeholder="Search projects, apps, endpoints…  or run a command" className="ap-spotlight-input" />
          </div>
          <Command.List className="ap-spotlight-list">
            <Command.Empty className="ap-spotlight-empty">No matches.</Command.Empty>

            <Command.Group heading="Actions" className="ap-spotlight-group">
              {actions.map((a) => (
                <Command.Item key={a.label} value={`action ${a.label}`} onSelect={a.run} className="ap-spotlight-item">
                  <span className="ap-spotlight-item-icon">{a.icon}</span>
                  <span className="ap-spotlight-item-label">{a.label}</span>
                </Command.Item>
              ))}
            </Command.Group>

            {projects.length > 0 && (
              <Command.Group heading="Projects" className="ap-spotlight-group">
                {projects.map((p) => (
                  <Command.Item key={p.slug} value={`project ${p.name} ${p.slug}`} onSelect={() => go(`/projects/${p.slug}/apps`)} className="ap-spotlight-item">
                    <span className="ap-spotlight-item-icon"><FolderKanban size={16} /></span>
                    <span className="ap-spotlight-item-label">{p.name}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {apps.length > 0 && (
              <Command.Group heading="Apps" className="ap-spotlight-group">
                {apps.map((a) => (
                  <Command.Item key={a.slug} value={`app ${a.name} ${a.slug}`} onSelect={() => go(`/projects/${projectSlug}/apps/${a.slug}/settings/general`)} className="ap-spotlight-item">
                    <span className="ap-spotlight-item-icon"><Layers size={16} /></span>
                    <span className="ap-spotlight-item-label">{a.name}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {endpoints.length > 0 && (
              <Command.Group heading="Endpoints" className="ap-spotlight-group">
                {endpoints.map((e, i) => (
                  <Command.Item
                    key={`${e.method}-${e.path}-${i}`}
                    value={`endpoint ${e.method} ${e.path}`}
                    onSelect={() => go(`/projects/${projectSlug}/endpoints/detail?method=${encodeURIComponent(e.method)}&path=${encodeURIComponent(e.path)}`)}
                    className="ap-spotlight-item"
                  >
                    <span className="ap-spotlight-item-icon"><Activity size={16} /></span>
                    <span className="ap-spotlight-item-label">
                      <span style={{ color: "var(--text-muted)", marginRight: 8 }}>{e.method}</span>{e.path}
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}
          </Command.List>
          <div className="ap-spotlight-foot">
            <span><span className="ap-kbd">↑</span> <span className="ap-kbd">↓</span> navigate</span>
            <span><span className="ap-kbd">↵</span> open</span>
            <span><span className="ap-kbd">esc</span> close</span>
          </div>
        </Command>
      </div>
    </div>,
    document.body,
  );
}
