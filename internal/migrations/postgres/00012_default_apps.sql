-- Every active project gets a default app whose slug is the project slug.
-- Ingest rejects app identifiers not registered on the project, and the
-- onboarding install screen tells SDKs to send app_id = <project slug>;
-- projects created through the API before this migration had no app at all,
-- so their first events were rejected. New projects get the app on create
-- (internal/controlplane/projects). Projects that already have an active app
-- are left alone, and the insert is a no-op on re-run.

-- +goose Up
INSERT INTO apps (id, project_id, slug, name)
SELECT gen_random_uuid(), p.id, p.slug, p.name
FROM projects p
WHERE p.deleted_at IS NULL
  AND NOT EXISTS (
      SELECT 1 FROM apps a WHERE a.project_id = p.id AND a.deleted_at IS NULL
  )
ON CONFLICT (project_id, slug) WHERE deleted_at IS NULL DO NOTHING;

-- +goose Down
-- Backfilled apps are indistinguishable from apps registered later, and
-- events may already reference them; nothing to undo.
SELECT 1;
