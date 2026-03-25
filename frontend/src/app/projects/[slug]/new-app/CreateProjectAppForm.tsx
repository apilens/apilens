"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";

type FrameworkId = "fastapi" | "flask" | "django" | "starlette";

const FRAMEWORK_OPTIONS: Array<{ id: FrameworkId; label: string }> = [
  { id: "fastapi", label: "FastAPI" },
  { id: "flask", label: "Flask" },
  { id: "django", label: "Django / Django Ninja" },
  { id: "starlette", label: "Starlette" },
];

interface CreateProjectAppFormProps {
  projectSlug: string;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export default function CreateProjectAppForm({ projectSlug }: CreateProjectAppFormProps) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [slugError, setSlugError] = useState("");
  const [slugChecking, setSlugChecking] = useState(false);
  const [description, setDescription] = useState("");
  const [framework, setFramework] = useState<FrameworkId>("fastapi");
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState("");
  const debounceTimer = useRef<NodeJS.Timeout | null>(null);

  // Reserved slugs
  const RESERVED_SLUGS = ["api", "admin", "dashboard", "settings", "new", "create", "edit", "delete", "health", "docs"];

  // Validate slug format
  const validateSlugFormat = (value: string): string => {
    if (!value) return "Slug is required";
    if (value.length < 2) return "Slug must be at least 2 characters";
    if (value.length > 100) return "Slug must be less than 100 characters";
    if (!/^[a-z0-9-]+$/.test(value)) return "Slug can only contain lowercase letters, numbers, and hyphens";
    if (value.startsWith("-") || value.endsWith("-")) return "Slug cannot start or end with a hyphen";
    if (value.includes("--")) return "Slug cannot contain consecutive hyphens";
    if (RESERVED_SLUGS.includes(value)) return `'${value}' is a reserved slug. Please choose a different one`;
    return "";
  };

  // Check slug availability with debounce
  useEffect(() => {
    if (!slug || !slugTouched) return;

    const formatError = validateSlugFormat(slug);
    if (formatError) {
      setSlugError(formatError);
      setSlugChecking(false);
      return;
    }

    // Clear previous timer
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }

    setSlugChecking(true);
    setSlugError("");

    // Debounce the availability check
    debounceTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/projects/${projectSlug}/apps/${slug}`);
        if (res.ok) {
          setSlugError("This slug is already taken");
        } else if (res.status === 404) {
          setSlugError(""); // Slug is available
        } else {
          setSlugError("Could not check slug availability");
        }
      } catch {
        setSlugError("Could not check slug availability");
      } finally {
        setSlugChecking(false);
      }
    }, 500);

    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, [slug, slugTouched, projectSlug]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    // Check for slug errors
    const finalSlug = slug.trim() || slugify(name.trim());
    const formatError = validateSlugFormat(finalSlug);
    if (formatError) {
      setSlugError(formatError);
      return;
    }
    if (slugError) return;

    setIsCreating(true);
    setError("");

    try {
      const res = await fetch(`/api/projects/${projectSlug}/apps`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          slug: slug.trim() || slugify(name.trim()),
          description: description.trim(),
          framework,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create app");

      // Get the project's API key (should always exist since it's auto-created with project)
      const keysRes = await fetch(`/api/projects/${projectSlug}/api-keys`);
      const keys = await keysRes.json();
      const apiKeyPrefix = keys && keys.length > 0 ? keys[0].prefix : "apilens_****";

      // Store setup metadata for the setup page
      if (typeof window !== "undefined") {
        window.localStorage.setItem(
          `apilens_setup_meta_${data.slug}`,
          JSON.stringify({
            appName: data.name,
            framework,
            apiKeyPrefix,
            projectSlug,
            createdAt: Date.now(),
          }),
        );
      }

      // Redirect to setup page
      router.push(`/projects/${projectSlug}/apps/${data.slug}/setup`);
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
          onChange={(e) => {
            const newName = e.target.value;
            setName(newName);
            if (!slugTouched) {
              setSlug(slugify(newName));
            }
          }}
          placeholder="My API Service"
          maxLength={100}
          autoFocus
          required
        />
      </div>

      <div className="create-app-field">
        <label htmlFor="app-slug" className="create-app-label">
          App slug
        </label>
        <div style={{ position: "relative" }}>
          <input
            id="app-slug"
            className="create-app-input"
            value={slug}
            onChange={(e) => {
              const value = e.target.value.toLowerCase();
              setSlug(value);
              setSlugTouched(true);
            }}
            placeholder="my-api-service"
            maxLength={100}
            required
            style={{
              borderColor: slugError ? "#ef4444" : slugTouched && !slugChecking && !slugError ? "#10b981" : undefined,
              paddingRight: "40px",
            }}
          />
          {slugTouched && (
            <div style={{ position: "absolute", right: "12px", top: "50%", transform: "translateY(-50%)" }}>
              {slugChecking ? (
                <Loader2 size={16} className="animate-spin" style={{ color: "var(--text-secondary)" }} />
              ) : slugError ? (
                <XCircle size={16} style={{ color: "#ef4444" }} />
              ) : (
                <CheckCircle2 size={16} style={{ color: "#10b981" }} />
              )}
            </div>
          )}
        </div>
        {slugError && (
          <p style={{ fontSize: "12px", color: "#ef4444", marginTop: "4px" }}>
            {slugError}
          </p>
        )}
        {!slugError && (
          <p style={{ fontSize: "12px", color: "var(--text-secondary)", marginTop: "4px" }}>
            Used in SDK configuration (e.g., app_id=&quot;{slug || "my-api-service"}&quot;)
          </p>
        )}
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
          placeholder="What does this service do?"
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
          onClick={() => router.push(`/projects/${projectSlug}`)}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="settings-btn settings-btn-primary"
          disabled={isCreating || !name.trim() || !slug.trim() || !!slugError || slugChecking}
        >
          {isCreating ? (
            <>
              <Loader2 size={14} strokeWidth={2} className="animate-spin" />
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
