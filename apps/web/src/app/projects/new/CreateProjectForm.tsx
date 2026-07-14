"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/reui/button";
import { Input } from "@/components/reui/input";
import { Label } from "@/components/reui/label";
import { Textarea } from "@/components/reui/textarea";
import { Alert, AlertDescription } from "@/components/reui/alert";

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
    <form onSubmit={handleSubmit} className="flex flex-col gap-5">
      {error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="project-name" className="text-[13px]">
          Project name
        </Label>
        <Input
          id="project-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Production Services"
          maxLength={100}
          autoFocus
          required
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="project-description" className="text-[13px]">
          Description <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          id="project-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Describe what this project is for"
          maxLength={500}
          rows={3}
        />
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => router.push("/projects")}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={isCreating || !name.trim()}>
          {isCreating ? (
            <>
              <Loader2 size={14} strokeWidth={2} className="animate-spin" />
              Creating...
            </>
          ) : (
            "Create Project"
          )}
        </Button>
      </div>
    </form>
  );
}
