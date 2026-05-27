"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import SettingsCard from "@/components/settings/SettingsCard";
import ConfirmDialog from "@/components/settings/ConfirmDialog";
import type { App } from "@/types/app";

interface AppDangerZoneSectionProps {
  app: App;
  onDelete: () => Promise<void>;
}

export default function AppDangerZoneSection({ app, onDelete }: AppDangerZoneSectionProps) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await onDelete();
    } finally {
      setIsDeleting(false);
      setShowConfirm(false);
    }
  };

  return (
    <>
      <SettingsCard
        title="Danger Zone"
        description="Irreversible actions for this app"
        variant="danger"
      >
        <div className="danger-zone-content">
          <div className="danger-zone-item">
            <div className="danger-zone-info">
              <p className="danger-zone-label">Delete App</p>
              <p className="danger-zone-description">
                Permanently delete this app and revoke all its API keys. This action cannot be undone.
              </p>
            </div>
            <button
              className="settings-btn settings-btn-danger"
              onClick={() => setShowConfirm(true)}
            >
              <Trash2 size={14} />
              Delete App
            </button>
          </div>
        </div>
      </SettingsCard>

      <ConfirmDialog
        isOpen={showConfirm}
        onClose={() => setShowConfirm(false)}
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
