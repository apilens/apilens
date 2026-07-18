"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell, Check, FileText, Loader2, Plus, Send, Trash2, X } from "lucide-react";
import SettingsCard from "@/components/settings/SettingsCard";

/* The Sentinel (Phase 5): alert channels, rules, and the recent-alerts feed.
   Two rule families — issue rules (new issue / regression, event-driven) and
   metric monitors (static threshold or anomaly band over a window). */

interface Channel {
  id: string;
  kind: "slack_webhook" | "webhook" | "email";
  name: string;
  config: { url?: string; emails?: string[] };
  is_active: boolean;
}

interface Rule {
  id: string;
  name: string;
  kind: "new_issue" | "regression" | "metric";
  is_active: boolean;
  environment: string;
  metric: string;
  window_minutes: number;
  threshold_type: "static" | "anomaly";
  comparison: string;
  threshold: number | null;
  direction: string;
  sensitivity: number;
  group_by: string;
  channel_ids: string[];
  auto_investigate: boolean;
  last_evaluated_at: string | null;
}

interface AlertEventRow {
  id: string;
  rule_name: string;
  rule_kind: string;
  transition: string;
  targets: { target: string; value: number | null; threshold: number | null }[];
  summary: string;
  created_at: string;
  delivery: Record<string, { ok: boolean; detail: string }>;
}

const METRICS = [
  { value: "server_error_rate", label: "Server 5xx rate" },
  { value: "error_rate", label: "Total error rate" },
  { value: "client_error_rate", label: "Client 4xx rate" },
  { value: "p95_latency", label: "p95 latency (ms)" },
  { value: "p50_latency", label: "p50 latency (ms)" },
  { value: "request_count", label: "Request count" },
];

export default function ProjectAlertsSection({
  projectSlug,
  showToast,
}: {
  projectSlug: string;
  showToast: (type: "success" | "error", message: string) => void;
}) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [events, setEvents] = useState<AlertEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");

  // Digest config
  const [digestActive, setDigestActive] = useState(false);
  const [digestCadence, setDigestCadence] = useState<"weekly" | "daily">("weekly");
  const [digestWeekday, setDigestWeekday] = useState(0);
  const [digestChannels, setDigestChannels] = useState<string[]>([]);
  const [digestPreview, setDigestPreview] = useState<string>("");

  // Channel form
  const [chKind, setChKind] = useState<Channel["kind"]>("slack_webhook");
  const [chName, setChName] = useState("");
  const [chTarget, setChTarget] = useState("");

  // Rule form
  const [ruleKind, setRuleKind] = useState<Rule["kind"]>("new_issue");
  const [ruleName, setRuleName] = useState("");
  const [ruleMetric, setRuleMetric] = useState("server_error_rate");
  const [ruleWindow, setRuleWindow] = useState(15);
  const [ruleThresholdType, setRuleThresholdType] = useState<"static" | "anomaly">("static");
  const [ruleComparison, setRuleComparison] = useState("gt");
  const [ruleThreshold, setRuleThreshold] = useState("");
  const [ruleGroupBy, setRuleGroupBy] = useState("");
  const [ruleChannels, setRuleChannels] = useState<string[]>([]);
  const [ruleAutoInvestigate, setRuleAutoInvestigate] = useState(false);

  const load = useCallback(async () => {
    try {
      const [alertsRes, digestRes] = await Promise.all([
        fetch(`/api/projects/${projectSlug}/alerts`),
        fetch(`/api/projects/${projectSlug}/digest`),
      ]);
      if (alertsRes.ok) {
        const data = await alertsRes.json();
        setChannels(data.channels || []);
        setRules(data.rules || []);
        setEvents(data.events || []);
      }
      if (digestRes.ok) {
        const d = await digestRes.json();
        if (d.exists) {
          setDigestActive(d.is_active);
          setDigestCadence(d.cadence);
          setDigestWeekday(d.weekday);
          setDigestChannels(d.channel_ids || []);
        }
      }
    } catch {
      showToast("error", "Failed to load alerts");
    } finally {
      setLoading(false);
    }
  }, [projectSlug, showToast]);

  const saveDigest = async () => {
    setBusy("save-digest");
    try {
      const res = await fetch(`/api/projects/${projectSlug}/digest`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          is_active: digestActive,
          cadence: digestCadence,
          weekday: digestWeekday,
          channel_ids: digestChannels,
        }),
      });
      if (!res.ok) throw new Error("Failed to save digest settings");
      showToast("success", "Digest settings saved");
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Failed to save digest");
    } finally {
      setBusy("");
    }
  };

  const previewDigest = async () => {
    setBusy("preview-digest");
    try {
      const res = await fetch(`/api/projects/${projectSlug}/analytics/digest-preview?days=${digestCadence === "daily" ? 1 : 7}`);
      const data = await res.json().catch(() => ({}));
      setDigestPreview(`${data.narrative || ""}\n\n${data.markdown || ""}`.trim());
    } finally {
      setBusy("");
    }
  };

  const sendDigestNow = async () => {
    setBusy("send-digest");
    try {
      const res = await fetch(`/api/projects/${projectSlug}/digest/send`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || data.error || "Failed to send digest");
      const ok = Object.values(data.delivery || {}).filter((d) => (d as { ok: boolean }).ok).length;
      showToast("success", `Digest sent (${ok} channel${ok === 1 ? "" : "s"})`);
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Failed to send digest");
    } finally {
      setBusy("");
    }
  };

  useEffect(() => {
    load();
  }, [load]);

  const addChannel = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy("add-channel");
    try {
      const config =
        chKind === "email"
          ? { emails: chTarget.split(",").map((s) => s.trim()).filter(Boolean) }
          : { url: chTarget.trim() };
      const res = await fetch(`/api/projects/${projectSlug}/alerts/channels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: chKind, name: chName, config }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || data.error || "Failed to add channel");
      setChName("");
      setChTarget("");
      showToast("success", "Channel added");
      await load();
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Failed to add channel");
    } finally {
      setBusy("");
    }
  };

  const testChannel = async (c: Channel) => {
    setBusy(`test-${c.id}`);
    try {
      const res = await fetch(`/api/projects/${projectSlug}/alerts/channels/${c.id}/test`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) showToast("success", `Test sent via ${c.name}`);
      else showToast("error", `Test failed: ${data.detail || "unknown"}`);
    } finally {
      setBusy("");
    }
  };

  const deleteChannel = async (c: Channel) => {
    setBusy(`del-${c.id}`);
    try {
      await fetch(`/api/projects/${projectSlug}/alerts/channels/${c.id}`, { method: "DELETE" });
      await load();
    } finally {
      setBusy("");
    }
  };

  const addRule = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy("add-rule");
    try {
      const body: Record<string, unknown> = {
        kind: ruleKind,
        name: ruleName,
        channel_ids: ruleChannels,
        auto_investigate: ruleAutoInvestigate,
      };
      if (ruleKind === "metric") {
        body.metric = ruleMetric;
        body.window_minutes = ruleWindow;
        body.threshold_type = ruleThresholdType;
        body.group_by = ruleGroupBy;
        if (ruleThresholdType === "static") {
          body.comparison = ruleComparison;
          body.threshold = parseFloat(ruleThreshold);
          if (Number.isNaN(body.threshold as number)) throw new Error("Threshold is required");
        } else {
          body.direction = "above";
        }
      }
      const res = await fetch(`/api/projects/${projectSlug}/alerts/rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || data.error || "Failed to add rule");
      setRuleName("");
      setRuleThreshold("");
      showToast("success", "Rule added");
      await load();
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "Failed to add rule");
    } finally {
      setBusy("");
    }
  };

  const toggleRule = async (r: Rule) => {
    setBusy(`toggle-${r.id}`);
    try {
      await fetch(`/api/projects/${projectSlug}/alerts/rules/${r.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !r.is_active }),
      });
      await load();
    } finally {
      setBusy("");
    }
  };

  const deleteRule = async (r: Rule) => {
    setBusy(`delrule-${r.id}`);
    try {
      await fetch(`/api/projects/${projectSlug}/alerts/rules/${r.id}`, { method: "DELETE" });
      await load();
    } finally {
      setBusy("");
    }
  };

  const ruleDescription = (r: Rule): string => {
    if (r.kind === "new_issue") return "Fires when a new error issue appears";
    if (r.kind === "regression") return "Fires when a resolved issue recurs";
    const metric = METRICS.find((m) => m.value === r.metric)?.label || r.metric;
    const scope = r.group_by === "consumer" ? " per consumer" : "";
    if (r.threshold_type === "anomaly") {
      return `${metric}${scope} deviates from its baseline (${r.window_minutes}m window)`;
    }
    return `${metric}${scope} ${r.comparison === "lt" ? "<" : ">"} ${r.threshold} (${r.window_minutes}m window)`;
  };

  if (loading) {
    return (
      <SettingsCard title="Alerts" description="Loading…">
        <Loader2 size={18} className="animate-spin" />
      </SettingsCard>
    );
  }

  return (
    <>
      <SettingsCard
        title="Notification channels"
        description="Where the Sentinel sends alerts: Slack incoming webhooks, generic webhooks, or email."
      >
        <div className="settings-section-content" style={{ gap: 8 }}>
          {channels.map((c) => (
            <div key={c.id} className="settings-inline-field" style={{ justifyContent: "space-between" }}>
              <span>
                <Bell size={14} style={{ verticalAlign: "-2px", marginRight: 6 }} />
                <strong>{c.name}</strong>
                <span className="settings-inline-help" style={{ marginLeft: 8 }}>
                  {c.kind === "email" ? (c.config.emails || []).join(", ") : c.kind}
                </span>
              </span>
              <span style={{ display: "flex", gap: 6 }}>
                <button type="button" className="settings-btn settings-btn-secondary settings-btn-sm" onClick={() => testChannel(c)} disabled={busy === `test-${c.id}`}>
                  {busy === `test-${c.id}` ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                  Test
                </button>
                <button type="button" className="settings-btn settings-btn-secondary settings-btn-sm" onClick={() => deleteChannel(c)} disabled={busy === `del-${c.id}`}>
                  {busy === `del-${c.id}` ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                </button>
              </span>
            </div>
          ))}

          <form onSubmit={addChannel} className="settings-inline-field" style={{ flexWrap: "wrap", gap: 8 }}>
            <select className="create-app-input" style={{ width: "auto" }} value={chKind} onChange={(e) => setChKind(e.target.value as Channel["kind"])}>
              <option value="slack_webhook">Slack webhook</option>
              <option value="webhook">Webhook</option>
              <option value="email">Email</option>
            </select>
            <input className="create-app-input" style={{ width: 140 }} placeholder="Name" value={chName} onChange={(e) => setChName(e.target.value)} required />
            <input
              className="create-app-input"
              style={{ flex: 1, minWidth: 220 }}
              placeholder={chKind === "email" ? "alice@co.com, bob@co.com" : "https://hooks.slack.com/services/…"}
              value={chTarget}
              onChange={(e) => setChTarget(e.target.value)}
              required
            />
            <button type="submit" className="settings-btn settings-btn-secondary settings-btn-sm" disabled={busy === "add-channel"}>
              {busy === "add-channel" ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
              Add
            </button>
          </form>
        </div>
      </SettingsCard>

      <SettingsCard
        title="Alert rules"
        description="Issue rules fire instantly from ingest (new issue, regression). Metric monitors watch a window every few minutes — with a static threshold or an anomaly band learned from history."
      >
        <div className="settings-section-content" style={{ gap: 8 }}>
          {rules.map((r) => (
            <div key={r.id} className="settings-inline-field" style={{ justifyContent: "space-between" }}>
              <span>
                <strong>{r.name}</strong>
                <span className="settings-inline-help" style={{ marginLeft: 8 }}>
                  {ruleDescription(r)}
                  {r.auto_investigate ? " · auto-investigates" : ""}
                  {!r.is_active ? " · disabled" : ""}
                </span>
              </span>
              <span style={{ display: "flex", gap: 6 }}>
                <button type="button" className="settings-btn settings-btn-secondary settings-btn-sm" onClick={() => toggleRule(r)} disabled={busy === `toggle-${r.id}`}>
                  {r.is_active ? <X size={13} /> : <Check size={13} />}
                  {r.is_active ? "Disable" : "Enable"}
                </button>
                <button type="button" className="settings-btn settings-btn-secondary settings-btn-sm" onClick={() => deleteRule(r)} disabled={busy === `delrule-${r.id}`}>
                  {busy === `delrule-${r.id}` ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                </button>
              </span>
            </div>
          ))}

          <form onSubmit={addRule} className="settings-section-content" style={{ gap: 8 }}>
            <div className="settings-inline-field" style={{ flexWrap: "wrap", gap: 8 }}>
              <select className="create-app-input" style={{ width: "auto" }} value={ruleKind} onChange={(e) => setRuleKind(e.target.value as Rule["kind"])}>
                <option value="new_issue">New issue</option>
                <option value="regression">Regression</option>
                <option value="metric">Metric monitor</option>
              </select>
              <input className="create-app-input" style={{ flex: 1, minWidth: 160 }} placeholder="Rule name" value={ruleName} onChange={(e) => setRuleName(e.target.value)} required />
            </div>

            {ruleKind === "metric" && (
              <div className="settings-inline-field" style={{ flexWrap: "wrap", gap: 8 }}>
                <select className="create-app-input" style={{ width: "auto" }} value={ruleMetric} onChange={(e) => setRuleMetric(e.target.value)}>
                  {METRICS.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
                <select className="create-app-input" style={{ width: "auto" }} value={ruleWindow} onChange={(e) => setRuleWindow(Number(e.target.value))}>
                  <option value={5}>5m window</option>
                  <option value={15}>15m window</option>
                  <option value={60}>60m window</option>
                </select>
                <select className="create-app-input" style={{ width: "auto" }} value={ruleThresholdType} onChange={(e) => setRuleThresholdType(e.target.value as "static" | "anomaly")}>
                  <option value="static">Static threshold</option>
                  <option value="anomaly">Anomaly band</option>
                </select>
                {ruleThresholdType === "static" ? (
                  <>
                    <select className="create-app-input" style={{ width: "auto" }} value={ruleComparison} onChange={(e) => setRuleComparison(e.target.value)}>
                      <option value="gt">above</option>
                      <option value="lt">below</option>
                    </select>
                    <input className="create-app-input" style={{ width: 110 }} placeholder="Threshold" value={ruleThreshold} onChange={(e) => setRuleThreshold(e.target.value)} required />
                    <select className="create-app-input" style={{ width: "auto" }} value={ruleGroupBy} onChange={(e) => setRuleGroupBy(e.target.value)}>
                      <option value="">Aggregate</option>
                      <option value="consumer">Per consumer</option>
                    </select>
                  </>
                ) : (
                  <span className="settings-inline-help">Baseline: trailing + same-time-yesterday/last-week windows, robust stats, deploy-aware.</span>
                )}
              </div>
            )}

            <div className="settings-inline-field" style={{ flexWrap: "wrap", gap: 10 }}>
              <span className="settings-inline-help">Notify:</span>
              {channels.length === 0 && <span className="settings-inline-help">add a channel above first</span>}
              {channels.map((c) => (
                <label key={c.id} className="settings-inline-help" style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={ruleChannels.includes(c.id)}
                    onChange={(e) =>
                      setRuleChannels((prev) => (e.target.checked ? [...prev, c.id] : prev.filter((x) => x !== c.id)))
                    }
                  />
                  {c.name}
                </label>
              ))}
              {(ruleKind === "new_issue" || ruleKind === "regression") && (
                <label className="settings-inline-help" style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                  <input type="checkbox" checked={ruleAutoInvestigate} onChange={(e) => setRuleAutoInvestigate(e.target.checked)} />
                  Auto-investigate with AI
                </label>
              )}
              <button type="submit" className="settings-btn settings-btn-secondary settings-btn-sm" disabled={busy === "add-rule"}>
                {busy === "add-rule" ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />}
                Add rule
              </button>
            </div>
          </form>
        </div>
      </SettingsCard>

      <SettingsCard
        title="API health digest"
        description="A recurring summary — new issues, regressions, resolved, worst/slowest endpoints, and API-surface changes — with an AI-written lead, sent through your channels."
      >
        <div className="settings-section-content" style={{ gap: 10 }}>
          <div className="settings-inline-field" style={{ flexWrap: "wrap", gap: 10 }}>
            <label className="settings-inline-help" style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
              <input type="checkbox" checked={digestActive} onChange={(e) => setDigestActive(e.target.checked)} />
              Enabled
            </label>
            <select className="create-app-input" style={{ width: "auto" }} value={digestCadence} onChange={(e) => setDigestCadence(e.target.value as "weekly" | "daily")}>
              <option value="weekly">Weekly</option>
              <option value="daily">Daily</option>
            </select>
            {digestCadence === "weekly" && (
              <select className="create-app-input" style={{ width: "auto" }} value={digestWeekday} onChange={(e) => setDigestWeekday(Number(e.target.value))}>
                {["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((d, i) => (
                  <option key={d} value={i}>{d}</option>
                ))}
              </select>
            )}
          </div>

          <div className="settings-inline-field" style={{ flexWrap: "wrap", gap: 10 }}>
            <span className="settings-inline-help">Send to:</span>
            {channels.length === 0 && <span className="settings-inline-help">add a channel above first</span>}
            {channels.map((c) => (
              <label key={c.id} className="settings-inline-help" style={{ display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={digestChannels.includes(c.id)}
                  onChange={(e) =>
                    setDigestChannels((prev) => (e.target.checked ? [...prev, c.id] : prev.filter((x) => x !== c.id)))
                  }
                />
                {c.name}
              </label>
            ))}
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button type="button" className="settings-btn settings-btn-secondary settings-btn-sm" onClick={saveDigest} disabled={busy === "save-digest"}>
              {busy === "save-digest" ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
              Save
            </button>
            <button type="button" className="settings-btn settings-btn-secondary settings-btn-sm" onClick={previewDigest} disabled={busy === "preview-digest"}>
              {busy === "preview-digest" ? <Loader2 size={13} className="animate-spin" /> : <FileText size={13} />}
              Preview
            </button>
            <button type="button" className="settings-btn settings-btn-secondary settings-btn-sm" onClick={sendDigestNow} disabled={busy === "send-digest"}>
              {busy === "send-digest" ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
              Send now
            </button>
          </div>

          {digestPreview ? (
            <pre className="request-payload-pre ep-log-trace" style={{ whiteSpace: "pre-wrap", maxHeight: 320, overflow: "auto" }}>
              {digestPreview}
            </pre>
          ) : null}
        </div>
      </SettingsCard>

      {events.length > 0 && (
        <SettingsCard title="Recent alerts" description="The last notifications the Sentinel sent.">
          <ul className="err-occ-list">
            {events.map((e) => (
              <li key={e.id} className="err-occ">
                <span className="err-occ-time">{new Date(e.created_at).toLocaleString()}</span>
                <span className="err-occ-consumer">
                  <strong>{e.rule_name}</strong> {e.transition}
                  {e.summary ? ` — ${e.summary}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </SettingsCard>
      )}
    </>
  );
}
