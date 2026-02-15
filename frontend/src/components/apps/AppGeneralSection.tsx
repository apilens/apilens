"use client";

import { useEffect, useState } from "react";
import { Loader2, Upload, Trash2 } from "lucide-react";
import SettingsCard from "@/components/settings/SettingsCard";
import AppIconEditor from "./AppIconEditor";
import ConfirmDialog from "@/components/settings/ConfirmDialog";
import type { App } from "@/types/app";
type FrameworkId = "fastapi" | "flask" | "django" | "starlette";

const FRAMEWORK_OPTIONS: Array<{ id: FrameworkId; label: string }> = [
  { id: "fastapi", label: "FastAPI" },
  { id: "flask", label: "Flask" },
  { id: "django", label: "Django / Django Ninja" },
  { id: "starlette", label: "Starlette" },
];

interface AppGeneralSectionProps {
  appSlug: string;
  app: App;
  onUpdate: (data: { name?: string; description?: string; framework?: FrameworkId }) => Promise<void>;
  onUploadIcon: (file: Blob) => Promise<void>;
  onRemoveIcon: () => Promise<void>;
  onDelete: () => Promise<void>;
}

export default function AppGeneralSection({
  appSlug,
  app,
  onUpdate,
  onUploadIcon,
  onRemoveIcon,
  onDelete,
}: AppGeneralSectionProps) {
  const [name, setName] = useState(app.name);
  const [description, setDescription] = useState(app.description);
  const [framework, setFramework] = useState<FrameworkId>(app.framework);
  const [isSaving, setIsSaving] = useState(false);
  const [showIconEditor, setShowIconEditor] = useState(false);
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
        <div className="app-general-form">
          <div className="create-app-field">
            <label className="create-app-label">App icon</label>
            <div className="app-icon-uploader">
              <span
                className="app-card-logo app-card-logo-app app-settings-icon-preview"
                role="button"
                tabIndex={0}
                onClick={() => setShowIconEditor(true)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setShowIconEditor(true);
                  }
                }}
              >
                {app.icon_url ? (
                  <img src={app.icon_url} alt={app.name} className="app-card-logo-image" />
                ) : (
                  (app.name.charAt(0) || "A").toUpperCase().slice(0, 2)
                )}
              </span>
              <div className="app-icon-uploader-actions">
                <button
                  type="button"
                  className="settings-btn settings-btn-secondary settings-btn-sm"
                  onClick={() => setShowIconEditor(true)}
                >
                  <Upload size={13} />
                  Upload
                </button>
                {app.icon_url ? (
                  <button
                    type="button"
                    className="settings-btn settings-btn-ghost settings-btn-sm"
                    onClick={onRemoveIcon}
                  >
                    <Trash2 size={13} />
                    Remove
                  </button>
                ) : null}
              </div>
            </div>
          </div>

          <div className="create-app-field">
            <label htmlFor="app-name" className="create-app-label">
              App name
            </label>
            <input
              id="app-name"
              className="create-app-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={100}
            />
          </div>

          <div className="create-app-field">
            <label htmlFor="app-description" className="create-app-label">
              Description
            </label>
            <textarea
              id="app-description"
              className="create-app-textarea"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
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

          <div className="app-general-actions">
            <button
              className="settings-btn settings-btn-primary"
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
            </button>
          </div>
        </div>
        </SettingsCard>

        <SettingsCard
          title="Delete App"
          description="Permanently delete this app and revoke all its API keys."
          variant="danger"
        >
          <div className="danger-zone-content">
            <div className="danger-zone-item">
              <div className="danger-zone-info">
                <p className="danger-zone-label">Danger Zone</p>
                <p className="danger-zone-description">
                  This action cannot be undone.
                </p>
              </div>
              <button
                className="settings-btn settings-btn-danger"
                onClick={() => setShowConfirmDelete(true)}
              >
                <Trash2 size={14} />
                Delete App
              </button>
            </div>
          </div>
        </SettingsCard>
      </div>

      {showIconEditor ? (
        <AppIconEditor
          currentIcon={app.icon_url}
          onSave={onUploadIcon}
          onRemove={onRemoveIcon}
          onClose={() => setShowIconEditor(false)}
        />
      ) : null}

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
