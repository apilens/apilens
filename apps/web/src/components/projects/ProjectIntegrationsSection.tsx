"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, GitBranch, Github, Link2, Loader2, Plus, Trash2, X } from "lucide-react";
import SettingsCard from "@/components/settings/SettingsCard";

/* Code Link (Phase 1): connect the GitHub App, link repositories, and define
   per-app code mappings. Monorepos map many apps to one repo with different
   source roots; polyrepos map each app to its own repo. */

interface Installation {
  id: string;
  installation_id: number;
  account_login: string;
  account_type: string;
  status: "active" | "suspended" | "revoked";
}

interface LinkedRepo {
  id: string;
  full_name: string;
  default_branch: string;
  is_active: boolean;
  account_login: string;
}

interface CodeMappingRow {
  id: string;
  app_slug: string;
  repository_id: string;
  repository: string;
  stack_trace_root: string;
  source_root: string;
  branch: string;
}

interface IntegrationStatus {
  configured: boolean;
  connected: boolean;
  installations: Installation[];
  repositories: LinkedRepo[];
  code_mappings: CodeMappingRow[];
}

interface AvailableRepo {
  installation_id: string;
  external_id: number;
  full_name: string;
  default_branch: string;
  private: boolean;
  linked: boolean;
}

interface AppRow {
  slug: string;
  name: string;
}

interface Props {
  projectSlug: string;
  showToast: (type: "success" | "error", message: string) => void;
}

export default function ProjectIntegrationsSection({ projectSlug, showToast }: Props) {
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [available, setAvailable] = useState<AvailableRepo[] | null>(null);
  const [apps, setApps] = useState<AppRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [busy, setBusy] = useState<string>("");

  // Mapping form state
  const [mapApp, setMapApp] = useState("");
  const [mapRepo, setMapRepo] = useState("");
  const [mapStackRoot, setMapStackRoot] = useState("/app/");
  const [mapSourceRoot, setMapSourceRoot] = useState("");

  const load = useCallback(async () => {
    try {
      const [statusRes, appsRes] = await Promise.all([
        fetch(`/api/projects/${projectSlug}/integrations/github`),
        fetch(`/api/projects/${projectSlug}/apps`),
      ]);
      if (statusRes.ok) setStatus(await statusRes.json());
      if (appsRes.ok) {
        const data = await appsRes.json();
        const rows: AppRow[] = Array.isArray(data) ? data : data.apps || [];
        setApps(rows);
      }
    } catch {
      showToast("error", "Failed to load integration status");
    } finally {
      setLoading(false);
    }
  }, [projectSlug, showToast]);

  useEffect(() => {
    load();
  }, [load]);

  const handleConnect = async () => {
    setConnecting(true);
    try {
      const res = await fetch(`/api/projects/${projectSlug}/integrations/github/install-url`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok || !data.url) {
        throw new Error(data.detail || data.error || "GitHub App is not configured on this server");
      }
      window.location.href = data.url;
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Failed to start GitHub connect");
      setConnecting(false);
    }
  };

  const openPicker = async () => {
    setPickerOpen(true);
    setPickerLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectSlug}/integrations/github/repos`);
      setAvailable(res.ok ? await res.json() : []);
    } catch {
      setAvailable([]);
    } finally {
      setPickerLoading(false);
    }
  };

  const linkRepo = async (repo: AvailableRepo) => {
    setBusy(`link-${repo.external_id}`);
    try {
      const res = await fetch(`/api/projects/${projectSlug}/integrations/github/repos`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(repo),
      });
      if (!res.ok) throw new Error("Failed to link repository");
      showToast("success", `Linked ${repo.full_name}`);
      setAvailable((prev) =>
        (prev || []).map((r) => (r.external_id === repo.external_id ? { ...r, linked: true } : r)),
      );
      await load();
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Failed to link repository");
    } finally {
      setBusy("");
    }
  };

  const unlinkRepo = async (repo: LinkedRepo) => {
    setBusy(`unlink-${repo.id}`);
    try {
      const res = await fetch(`/api/projects/${projectSlug}/integrations/github/repos/${repo.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to unlink repository");
      showToast("success", `Unlinked ${repo.full_name}`);
      await load();
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Failed to unlink repository");
    } finally {
      setBusy("");
    }
  };

  const removeInstallation = async (install: Installation) => {
    if (!confirm(`Disconnect ${install.account_login}? Linked repos and code mappings under it will be removed.`)) return;
    setBusy(`rm-${install.id}`);
    try {
      const res = await fetch(`/api/projects/${projectSlug}/integrations/github/${install.id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to disconnect");
      showToast("success", `Disconnected ${install.account_login}`);
      await load();
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Failed to disconnect");
    } finally {
      setBusy("");
    }
  };

  const addMapping = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mapApp || !mapRepo || !mapStackRoot.trim()) {
      showToast("error", "App, repository, and stack trace root are required");
      return;
    }
    setBusy("add-mapping");
    try {
      const res = await fetch(`/api/projects/${projectSlug}/apps/${mapApp}/code-mappings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repository_id: mapRepo,
          stack_trace_root: mapStackRoot,
          source_root: mapSourceRoot,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || body.error || "Failed to add code mapping");
      }
      showToast("success", "Code mapping added");
      setMapSourceRoot("");
      await load();
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Failed to add code mapping");
    } finally {
      setBusy("");
    }
  };

  const deleteMapping = async (m: CodeMappingRow) => {
    setBusy(`delmap-${m.id}`);
    try {
      const res = await fetch(
        `/api/projects/${projectSlug}/apps/${m.app_slug}/code-mappings/${m.id}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error("Failed to delete mapping");
      await load();
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Failed to delete mapping");
    } finally {
      setBusy("");
    }
  };

  if (loading) {
    return (
      <SettingsCard title="GitHub" description="Loading integration status…">
        <Loader2 size={18} className="animate-spin" />
      </SettingsCard>
    );
  }

  const installations = status?.installations || [];
  const repos = status?.repositories || [];
  const mappings = status?.code_mappings || [];
  const broken = installations.filter((i) => i.status !== "active");

  return (
    <>
      <SettingsCard
        title="GitHub"
        description="Connect your GitHub account so stack traces link to source, error issues show suspect commits, and (soon) fixes hand off to coding agents. Works for monorepos and one-repo-per-app alike."
      >
        {!status?.configured && (
          <p className="settings-inline-help">
            <AlertTriangle size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
            The APILens GitHub App isn&apos;t configured on this server
            (APILENS_GITHUB_APP_SLUG / _APP_ID / _PRIVATE_KEY).
          </p>
        )}

        {broken.length > 0 && (
          <p className="settings-inline-help" style={{ color: "var(--error, #f87171)" }}>
            <AlertTriangle size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
            {broken.map((i) => `${i.account_login} (${i.status})`).join(", ")} — the app was
            uninstalled or suspended on GitHub. Reconnect to restore code links.
          </p>
        )}

        {installations.length === 0 ? (
          <button
            type="button"
            className="settings-btn settings-btn-primary"
            onClick={handleConnect}
            disabled={connecting || !status?.configured}
          >
            {connecting ? <Loader2 size={14} className="animate-spin" /> : <Github size={14} />}
            Connect GitHub
          </button>
        ) : (
          <div className="settings-section-content" style={{ gap: 8 }}>
            {installations.map((i) => (
              <div key={i.id} className="settings-inline-field" style={{ justifyContent: "space-between" }}>
                <span>
                  <Github size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
                  <strong>{i.account_login}</strong>
                  <span className="settings-inline-help" style={{ marginLeft: 8 }}>
                    {i.account_type} · {i.status === "active" ? <><Check size={12} style={{ verticalAlign: "-1px" }} /> active</> : i.status}
                  </span>
                </span>
                <button
                  type="button"
                  className="settings-btn settings-btn-secondary settings-btn-sm"
                  onClick={() => removeInstallation(i)}
                  disabled={busy === `rm-${i.id}`}
                >
                  {busy === `rm-${i.id}` ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />}
                  Disconnect
                </button>
              </div>
            ))}
            <div>
              <button
                type="button"
                className="settings-btn settings-btn-secondary settings-btn-sm"
                onClick={handleConnect}
                disabled={connecting}
              >
                <Plus size={13} /> Add another account
              </button>
            </div>
          </div>
        )}
      </SettingsCard>

      {installations.some((i) => i.status === "active") && (
        <SettingsCard
          title="Repositories"
          description="Link the repositories your apps are deployed from."
        >
          <div className="settings-section-content" style={{ gap: 8 }}>
            {repos.length === 0 && (
              <p className="settings-inline-help">No repositories linked yet.</p>
            )}
            {repos.map((r) => (
              <div key={r.id} className="settings-inline-field" style={{ justifyContent: "space-between" }}>
                <span>
                  <GitBranch size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
                  <code className="settings-inline-code">{r.full_name}</code>
                  <span className="settings-inline-help" style={{ marginLeft: 8 }}>
                    {r.default_branch}
                    {!r.is_active && " · access revoked"}
                  </span>
                </span>
                <button
                  type="button"
                  className="settings-btn settings-btn-secondary settings-btn-sm"
                  onClick={() => unlinkRepo(r)}
                  disabled={busy === `unlink-${r.id}`}
                >
                  {busy === `unlink-${r.id}` ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                  Unlink
                </button>
              </div>
            ))}

            {!pickerOpen ? (
              <div>
                <button type="button" className="settings-btn settings-btn-secondary settings-btn-sm" onClick={openPicker}>
                  <Link2 size={13} /> Link a repository
                </button>
              </div>
            ) : pickerLoading ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <div className="settings-section-content" style={{ gap: 6 }}>
                {(available || []).filter((r) => !r.linked).length === 0 && (
                  <p className="settings-inline-help">
                    No more repositories available — grant the GitHub App access to more repos on GitHub.
                  </p>
                )}
                {(available || [])
                  .filter((r) => !r.linked)
                  .slice(0, 30)
                  .map((r) => (
                    <div key={r.external_id} className="settings-inline-field" style={{ justifyContent: "space-between" }}>
                      <code className="settings-inline-code">{r.full_name}</code>
                      <button
                        type="button"
                        className="settings-btn settings-btn-secondary settings-btn-sm"
                        onClick={() => linkRepo(r)}
                        disabled={busy === `link-${r.external_id}`}
                      >
                        {busy === `link-${r.external_id}` ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
                        Link
                      </button>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </SettingsCard>
      )}

      {repos.some((r) => r.is_active) && (
        <SettingsCard
          title="Code mappings"
          description="Teach APILens where each app's code lives: the runtime path prefix seen in stack traces (e.g. /app/) and the matching folder in the repo (empty = repo root; for monorepos e.g. services/checkout/)."
        >
          <div className="settings-section-content" style={{ gap: 8 }}>
            {mappings.map((m) => (
              <div key={m.id} className="settings-inline-field" style={{ justifyContent: "space-between" }}>
                <span>
                  <code className="settings-inline-code">{m.app_slug}</code>
                  <span className="settings-inline-help" style={{ margin: "0 6px" }}>maps</span>
                  <code className="settings-inline-code">{m.stack_trace_root}</code>
                  <span className="settings-inline-help" style={{ margin: "0 6px" }}>→</span>
                  <code className="settings-inline-code">
                    {m.repository}/{m.source_root || ""}
                  </code>
                </span>
                <button
                  type="button"
                  className="settings-btn settings-btn-secondary settings-btn-sm"
                  onClick={() => deleteMapping(m)}
                  disabled={busy === `delmap-${m.id}`}
                >
                  {busy === `delmap-${m.id}` ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                </button>
              </div>
            ))}

            <form onSubmit={addMapping} className="settings-inline-field" style={{ flexWrap: "wrap", gap: 8 }}>
              <select
                className="create-app-input"
                style={{ width: "auto" }}
                value={mapApp}
                onChange={(e) => setMapApp(e.target.value)}
              >
                <option value="">App…</option>
                {apps.map((a) => (
                  <option key={a.slug} value={a.slug}>
                    {a.name || a.slug}
                  </option>
                ))}
              </select>
              <select
                className="create-app-input"
                style={{ width: "auto" }}
                value={mapRepo}
                onChange={(e) => setMapRepo(e.target.value)}
              >
                <option value="">Repository…</option>
                {repos.filter((r) => r.is_active).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.full_name}
                  </option>
                ))}
              </select>
              <input
                className="create-app-input"
                style={{ width: 130 }}
                value={mapStackRoot}
                onChange={(e) => setMapStackRoot(e.target.value)}
                placeholder="/app/"
                title="Stack trace root — runtime path prefix"
              />
              <input
                className="create-app-input"
                style={{ width: 170 }}
                value={mapSourceRoot}
                onChange={(e) => setMapSourceRoot(e.target.value)}
                placeholder="source root (optional)"
                title="Repo folder the stack root maps to (empty = repo root)"
              />
              <button type="submit" className="settings-btn settings-btn-secondary settings-btn-sm" disabled={busy === "add-mapping"}>
                {busy === "add-mapping" ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
                Add mapping
              </button>
            </form>
          </div>
        </SettingsCard>
      )}
    </>
  );
}
