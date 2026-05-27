"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

export default function CreateProjectForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    setIsCreating(true);
    setError("");

    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create project");

      // Redirect to the new project page
      router.push(`/projects/${data.slug}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="create-app-form">
      {error && <div className="create-app-error">{error}</div>}

      <div className="create-app-field">
        <label htmlFor="project-name" className="create-app-label">
          Project name
        </label>
        <input
          id="project-name"
          className="create-app-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Production Services"
          maxLength={100}
          autoFocus
          required
        />
      </div>

      <div className="create-app-field">
        <label htmlFor="project-description" className="create-app-label">
          Description <span className="create-app-optional">(optional)</span>
        </label>
        <textarea
          id="project-description"
          className="create-app-textarea"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Describe what this project is for"
          maxLength={500}
          rows={3}
        />
      </div>

      <div className="create-app-actions">
        <button
          type="button"
          className="settings-btn settings-btn-secondary"
          onClick={() => router.push("/projects")}
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
              <Loader2 size={14} strokeWidth={2} className="animate-spin" />
              Creating...
            </>
          ) : (
            "Create Project"
          )}
        </button>
      </div>
    </form>
  );
}
