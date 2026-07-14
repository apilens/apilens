"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Loader2, CheckCircle2, XCircle, Copy, Check, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/reui/button";
import { Input } from "@/components/reui/input";
import { Label } from "@/components/reui/label";
import { Textarea } from "@/components/reui/textarea";
import { Alert, AlertDescription } from "@/components/reui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/reui/select";

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
  const [copiedProjectSlug, setCopiedProjectSlug] = useState(false);
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
          `apilens_setup_meta_${projectSlug}_${data.slug}`,
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

  const handleCopyProjectSlug = async () => {
    try {
      await navigator.clipboard.writeText(projectSlug);
      setCopiedProjectSlug(true);
      window.setTimeout(() => setCopiedProjectSlug(false), 1400);
    } catch {
      setError("Failed to copy project slug. Copy it manually.");
    }
  };

  const slugState = slugTouched
    ? slugChecking
      ? "checking"
      : slugError
        ? "error"
        : "valid"
    : "idle";

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      {error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="app-name" className="text-[13px]">
          App name
        </Label>
        <Input
          id="app-name"
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

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="project-slug" className="text-[13px]">
          Project slug
        </Label>
        <div className="flex items-center gap-2">
          <div
            id="project-slug"
            aria-readonly="true"
            className="flex h-9 min-w-0 flex-1 items-center rounded-md border border-border bg-muted px-3"
          >
            <code className="truncate font-mono text-[13px] text-foreground">{projectSlug}</code>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleCopyProjectSlug}
          >
            {copiedProjectSlug ? <Check size={14} /> : <Copy size={14} />}
            {copiedProjectSlug ? "Copied" : "Copy"}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">This stays fixed for every app inside this project.</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="app-slug" className="text-[13px]">
          App ID
        </Label>
        <div className="relative">
          <Input
            id="app-slug"
            aria-invalid={slugState === "error" || undefined}
            className={cn(
              "pr-9",
              slugState === "valid" && "border-success focus-visible:border-success focus-visible:ring-success/20",
            )}
            value={slug}
            onChange={(e) => {
              const value = e.target.value.toLowerCase();
              setSlug(value);
              setSlugTouched(true);
            }}
            placeholder="my-api-service"
            maxLength={100}
            required
          />
          {slugTouched && (
            <div className="pointer-events-none absolute inset-y-0 right-3 flex items-center">
              {slugChecking ? (
                <Loader2 size={16} className="animate-spin text-muted-foreground" />
              ) : slugError ? (
                <XCircle size={16} className="text-destructive" />
              ) : (
                <CheckCircle2 size={16} className="text-success" />
              )}
            </div>
          )}
        </div>
        <div
          className={cn(
            "text-xs text-muted-foreground",
            slugState === "error" && "text-destructive",
            slugState === "valid" && "text-success",
          )}
        >
          {slugState === "checking" && "Checking availability for this app ID."}
          {slugState === "error" && slugError}
          {slugState === "valid" && "Available. This will be used as app_id in the SDK."}
          {slugState === "idle" && "Auto-generated from the app name. You can change it if needed."}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="app-description" className="text-[13px]">
          Description <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          id="app-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What does this service do?"
          maxLength={500}
          rows={3}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="app-framework" className="text-[13px]">
          Framework
        </Label>
        <Select
          value={framework}
          onValueChange={(value) => setFramework(value as FrameworkId)}
        >
          <SelectTrigger id="app-framework" className="w-full">
            <SelectValue placeholder="Select a framework" />
          </SelectTrigger>
          <SelectContent>
            {FRAMEWORK_OPTIONS.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => router.push(`/projects/${projectSlug}`)}
        >
          Cancel
        </Button>
        <Button
          type="submit"
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
        </Button>
      </div>
    </form>
  );
}
