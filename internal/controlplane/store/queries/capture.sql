-- name: GetCaptureApp :one
-- An active app of an active project, with what authorizing a request on it
-- needs (the project slug, which the authz guard resolves).
SELECT a.id, a.slug, a.project_id, p.slug AS project_slug, p.org_id
FROM apps a
JOIN projects p ON p.id = a.project_id
WHERE a.id = @id AND a.deleted_at IS NULL AND p.deleted_at IS NULL;

-- name: GetCapturePolicy :one
-- The capture policy row of an active app; no row means capture everything.
SELECT cp.app_id, cp.enabled, cp.sample_rate::float8 AS sample_rate,
       cp.capture_headers, cp.capture_request_body, cp.capture_response_body,
       cp.max_payload_bytes, cp.updated_at, cp.updated_by
FROM capture_policies cp
JOIN apps a ON a.id = cp.app_id
WHERE cp.app_id = @app_id AND a.deleted_at IS NULL;

-- name: UpsertCapturePolicy :one
INSERT INTO capture_policies (app_id, enabled, sample_rate, capture_headers, capture_request_body,
                              capture_response_body, max_payload_bytes, updated_at, updated_by)
VALUES (@app_id, @enabled, @sample_rate::float8, @capture_headers, @capture_request_body,
        @capture_response_body, sqlc.narg(max_payload_bytes)::integer, now(), @updated_by)
ON CONFLICT (app_id)
DO UPDATE SET enabled               = EXCLUDED.enabled,
              sample_rate           = EXCLUDED.sample_rate,
              capture_headers       = EXCLUDED.capture_headers,
              capture_request_body  = EXCLUDED.capture_request_body,
              capture_response_body = EXCLUDED.capture_response_body,
              max_payload_bytes     = EXCLUDED.max_payload_bytes,
              updated_at            = now(),
              updated_by            = EXCLUDED.updated_by
RETURNING app_id, enabled, sample_rate::float8 AS sample_rate,
          capture_headers, capture_request_body, capture_response_body,
          max_payload_bytes, updated_at, updated_by;
