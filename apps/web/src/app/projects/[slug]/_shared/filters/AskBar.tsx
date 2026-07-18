"use client";

import { useState } from "react";
import { Loader2, Sparkles, X } from "lucide-react";

/* "Ask APILens" (Phase 3): natural language → the rich filter DSL, translated
   server-side (validated against the real parser) and applied to the page's
   FilterBar. Renders as a slim input that stays out of the way until used. */

interface AskResult {
  filter: string;
  hours: number;
  explanation: string;
}

export default function AskBar({
  projectSlug,
  onFilter,
}: {
  projectSlug: string;
  onFilter: (filter: string) => void;
}) {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const ask = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = question.trim();
    if (!q || loading) return;
    setLoading(true);
    setNote(null);
    try {
      const res = await fetch(`/api/projects/${projectSlug}/analytics/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      const data = (await res.json().catch(() => ({}))) as AskResult & { detail?: string; error?: string };
      if (!res.ok) {
        throw new Error(data.detail || data.error || "Could not translate that question");
      }
      if (!data.filter) {
        setNote({ kind: "err", text: data.explanation || "That doesn't translate to a traffic filter — try naming a status, path, consumer, latency, or release." });
        return;
      }
      onFilter(data.filter);
      setNote({ kind: "ok", text: data.explanation || `Applied: ${data.filter}` });
    } catch (err) {
      setNote({ kind: "err", text: err instanceof Error ? err.message : "Ask failed" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="askbar">
      <form onSubmit={ask} className="askbar-form" style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Sparkles size={14} style={{ color: "var(--text-muted)", flexShrink: 0 }} />
        <input
          className="askbar-input"
          style={{
            flex: 1,
            background: "transparent",
            border: "none",
            outline: "none",
            color: "var(--text-primary)",
            fontSize: 13,
            minWidth: 0,
          }}
          placeholder='Ask APILens — e.g. "slow 5xx on checkout from acme this week"'
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          disabled={loading}
        />
        {loading ? (
          <Loader2 size={14} className="animate-spin" style={{ color: "var(--text-muted)" }} />
        ) : question ? (
          <button
            type="button"
            aria-label="Clear"
            onClick={() => {
              setQuestion("");
              setNote(null);
            }}
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: 0, display: "flex" }}
          >
            <X size={14} />
          </button>
        ) : null}
      </form>
      {note ? (
        <p
          className="settings-inline-help"
          style={{ margin: "4px 0 0 22px", color: note.kind === "err" ? "var(--error, #f87171)" : undefined }}
        >
          {note.text}
        </p>
      ) : null}
    </div>
  );
}
