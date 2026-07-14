"use client";

import { useEffect, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import SettingsCard from "@/components/settings/SettingsCard";
import ConfirmDialog from "@/components/settings/ConfirmDialog";
import { Button } from "@/components/reui/button";
import { Input } from "@/components/reui/input";
import { Label } from "@/components/reui/label";
import { Textarea } from "@/components/reui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/reui/select";
import type { App, FrameworkId } from "@/types/app";

const FRAMEWORK_OPTIONS: Array<{ id: FrameworkId; label: string }> = [
  { id: "fastapi", label: "FastAPI" },
  { id: "flask", label: "Flask" },
  { id: "django", label: "Django / Django Ninja" },
  { id: "starlette", label: "Starlette" },
  { id: "express", label: "Express" },
];

interface AppGeneralSectionProps {
  appSlug: string;
  app: App;
  onUpdate: (data: { name?: string; description?: string; framework?: FrameworkId }) => Promise<void>;
  onDelete: () => Promise<void>;
}

export default function AppGeneralSection({
  appSlug,
  app,
  onUpdate,
  onDelete,
}: AppGeneralSectionProps) {
  const [name, setName] = useState(app.name);
  const [description, setDescription] = useState(app.description);
  const [framework, setFramework] = useState<FrameworkId>(app.framework);
  const [isSaving, setIsSaving] = useState(false);
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    setName(app.name);
    setDescription(app.description);
    setFramework(app.framework);
  }, [app.name, app.description, app.framework]);

  const hasChanges = name !== app.name || description !== app.description || framework !== app.framework;

  const handleSave = async () => {
    if (!name.trim()) return;
    setIsSaving(true);
    try {
      const updates: { name?: string; description?: string; framework?: FrameworkId } = {};
      if (name !== app.name) updates.name = name.trim();
      if (description !== app.description) updates.description = description.trim();
      if (framework !== app.framework) updates.framework = framework;
      await onUpdate(updates);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await onDelete();
    } finally {
      setIsDeleting(false);
      setShowConfirmDelete(false);
    }
  };

  return (
    <>
      <div className="settings-section-content">
        <SettingsCard title="App Details" description="Update your app name and description">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="app-name" className="text-[13px]">
              App name
            </Label>
            <Input
              id="app-name"
              className="text-[13px]"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="app-description" className="text-[13px]">
              Description
            </Label>
            <Textarea
              id="app-description"
              className="text-[13px]"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              rows={3}
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="app-framework" className="text-[13px]">
              Framework
            </Label>
            <Select
              value={framework}
              onValueChange={(value) => setFramework(value as FrameworkId)}
            >
              <SelectTrigger id="app-framework" className="w-full text-[13px]">
                <SelectValue />
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

          <div className="flex justify-end pt-1">
            <Button
              disabled={isSaving || !hasChanges || !name.trim()}
              onClick={handleSave}
            >
              {isSaving ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Saving...
                </>
              ) : (
                "Save changes"
              )}
            </Button>
          </div>
        </div>
        </SettingsCard>

        <SettingsCard
          title="Delete App"
          description="Permanently delete this app and revoke all its API keys."
          variant="danger"
        >
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-foreground">Danger Zone</p>
              <p className="mt-0.5 text-[13px] text-muted-foreground">
                This action cannot be undone.
              </p>
            </div>
            <Button variant="destructive" onClick={() => setShowConfirmDelete(true)}>
              <Trash2 size={14} />
              Delete App
            </Button>
          </div>
        </SettingsCard>
      </div>

      <ConfirmDialog
        isOpen={showConfirmDelete}
        onClose={() => setShowConfirmDelete(false)}
        onConfirm={handleDelete}
        title="Delete App"
        description={`This will permanently delete "${app.name}" and revoke all its API keys. Any integrations using these keys will stop working immediately.`}
        confirmText="Delete App"
        confirmWord={app.name}
        variant="danger"
        isLoading={isDeleting}
      />
    </>
  );
}
