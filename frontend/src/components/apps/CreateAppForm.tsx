"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

type FrameworkId = "fastapi" | "flask" | "django" | "starlette";

const FRAMEWORK_OPTIONS: Array<{ id: FrameworkId; label: string }> = [
  { id: "fastapi", label: "FastAPI" },
  { id: "flask", label: "Flask" },
  { id: "django", label: "Django / Django Ninja" },
  { id: "starlette", label: "Starlette" },
];

export default function CreateAppForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [framework, setFramework] = useState<FrameworkId>("fastapi");
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    setIsCreating(true);
    setError("");

    try {
      const res = await fetch("/api/apps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          framework,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create app");

      const keyRes = await fetch(`/api/apps/${data.slug}/api-keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `${framework}-default-key` }),
      });
      const keyData = await keyRes.json();
      if (!keyRes.ok || !keyData.key) {
        throw new Error(keyData.error || "App created, but API key generation failed");
      }

      if (typeof window !== "undefined") {
        const createdAt = Date.now();
        const apiKeyPrefix = keyData.prefix || String(keyData.key).slice(0, 16);

        // Keep raw key ephemeral (session only), for one-time reveal.
        window.sessionStorage.setItem(
          `apilens_setup_secret_${data.slug}`,
          JSON.stringify({
            appName: data.name,
            framework,
            apiKey: keyData.key,
            createdAt,
          }),
        );

        // Keep non-sensitive setup metadata persistent for future refreshes.
        window.localStorage.setItem(
          `apilens_setup_meta_${data.slug}`,
          JSON.stringify({
            appName: data.name,
            framework,
            apiKeyPrefix,
            createdAt,
          }),
        );

        // Cleanup older key format if present.
        window.sessionStorage.removeItem(`apilens_setup_${data.slug}`);
      }

      window.location.assign(`/apps/${data.slug}/setup`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create app");
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="create-app-form">
      {error && <div className="create-app-error">{error}</div>}

      <div className="create-app-field">
        <label htmlFor="app-name" className="create-app-label">
          App name
        </label>
        <input
          id="app-name"
          className="create-app-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My API Project"
          maxLength={100}
          autoFocus
          required
        />
      </div>

      <div className="create-app-field">
        <label htmlFor="app-description" className="create-app-label">
          Description <span className="create-app-optional">(optional)</span>
        </label>
        <textarea
          id="app-description"
          className="create-app-textarea"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What does this app monitor?"
          maxLength={500}
          rows={3}
        />
      </div>

      <div className="create-app-field">
        <label htmlFor="app-framework" className="create-app-label">
          Framework
        </label>
        <select
          id="app-framework"
          className="create-app-input"
          value={framework}
          onChange={(e) => setFramework(e.target.value as FrameworkId)}
        >
          {FRAMEWORK_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="create-app-actions">
        <button
          type="button"
          className="settings-btn settings-btn-secondary"
          onClick={() => router.push("/apps")}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="settings-btn settings-btn-primary"
          disabled={isCreating || !name.trim()}
        >
          {isCreating ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              Creating...
            </>
          ) : (
            "Create App"
          )}
        </button>
      </div>
    </form>
  );
}
