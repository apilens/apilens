-- Scopes audit events to an organization and a project (ADR D7: one audit
-- store, shown per org and per project). Until now the org and project ids
-- lived in metadata, so the log could not be filtered or listed by them.
--
--   audit_events.org_id      the organization the event belongs to (NULL = a
--                            personal account event)
--   audit_events.project_id  the project it belongs to (NULL = org-wide)
--   audit_events.target_*    what was acted on: type ('api_key', 'member'),
--                            id, and a label readable after the target is gone
--   audit_events.request_id  the HTTP request that caused it
--   audit_events.changes     {"previous": ..., "next": ...}
--   audit_events.actor_label the actor's name at the time, so the row stays
--                            readable after the actor is purged
--
-- org_id and project_id carry no foreign key: the log is append-only history
-- and outlives the org or project it describes.
--
-- user_id changes from ON DELETE CASCADE to ON DELETE SET NULL: org and
-- project history outlives the person. Their personal events (org_id IS
-- NULL) are still removed: the purge job deletes them explicitly before it
-- deletes the user (DeletePersonalAuditEventsForUsers).
--
-- Existing rows get org_id/project_id from metadata where it holds a valid
-- id, and org-scoped rows get actor_label from the actor's current name.

-- +goose Up
ALTER TABLE audit_events
    ADD COLUMN IF NOT EXISTS org_id       uuid,
    ADD COLUMN IF NOT EXISTS project_id   uuid,
    ADD COLUMN IF NOT EXISTS target_type  text,
    ADD COLUMN IF NOT EXISTS target_id    text,
    ADD COLUMN IF NOT EXISTS target_label text,
    ADD COLUMN IF NOT EXISTS request_id   text,
    ADD COLUMN IF NOT EXISTS changes      jsonb,
    ADD COLUMN IF NOT EXISTS actor_label  text;

ALTER TABLE audit_events
    DROP CONSTRAINT IF EXISTS audit_events_user_id_fkey,
    ADD CONSTRAINT audit_events_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL;

UPDATE audit_events
SET org_id = (metadata->>'org_id')::uuid
WHERE org_id IS NULL
  AND metadata->>'org_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

UPDATE audit_events
SET project_id = (metadata->>'project_id')::uuid
WHERE project_id IS NULL
  AND metadata->>'project_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

UPDATE audit_events e
SET actor_label = COALESCE(NULLIF(u.name, ''), u.email::text)
FROM users u
WHERE e.actor_user_id = u.id AND e.org_id IS NOT NULL AND e.actor_label IS NULL;

CREATE INDEX IF NOT EXISTS audit_events_org_created
    ON audit_events (org_id, created_at DESC, id DESC) WHERE org_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_events_project_created
    ON audit_events (project_id, created_at DESC, id DESC) WHERE project_id IS NOT NULL;

-- +goose Down
DROP INDEX IF EXISTS audit_events_project_created;
DROP INDEX IF EXISTS audit_events_org_created;

ALTER TABLE audit_events
    DROP CONSTRAINT IF EXISTS audit_events_user_id_fkey,
    ADD CONSTRAINT audit_events_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;

ALTER TABLE audit_events
    DROP COLUMN IF EXISTS actor_label,
    DROP COLUMN IF EXISTS changes,
    DROP COLUMN IF EXISTS request_id,
    DROP COLUMN IF EXISTS target_label,
    DROP COLUMN IF EXISTS target_id,
    DROP COLUMN IF EXISTS target_type,
    DROP COLUMN IF EXISTS project_id,
    DROP COLUMN IF EXISTS org_id;
