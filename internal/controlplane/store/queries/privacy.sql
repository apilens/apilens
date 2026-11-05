-- name: ListProjectPrivacyPolicies :many
-- Every privacy policy row of a project: the project-wide one (app_id NULL)
-- and the per-app ones. Rows of deleted apps are skipped.
SELECT pp.app_id, pp.mask_query_params, pp.mask_headers, pp.mask_body_fields, pp.updated_at
FROM privacy_policies pp
LEFT JOIN apps a ON a.id = pp.app_id
WHERE pp.project_id = @project_id
  AND (pp.app_id IS NULL OR a.deleted_at IS NULL);

-- name: GetPrivacyPolicy :one
-- The policy of one scope: the project (app_id NULL) or one of its apps.
SELECT mask_query_params, mask_headers, mask_body_fields, updated_at
FROM privacy_policies
WHERE project_id = @project_id AND app_id IS NOT DISTINCT FROM sqlc.narg(app_id)::uuid;

-- name: UpsertPrivacyPolicy :one
INSERT INTO privacy_policies (id, project_id, app_id, mask_query_params, mask_headers, mask_body_fields, updated_at)
VALUES (@id, @project_id, sqlc.narg(app_id)::uuid, @mask_query_params, @mask_headers, @mask_body_fields, now())
ON CONFLICT (project_id, app_id)
DO UPDATE SET mask_query_params = EXCLUDED.mask_query_params,
              mask_headers      = EXCLUDED.mask_headers,
              mask_body_fields  = EXCLUDED.mask_body_fields,
              updated_at        = now()
RETURNING mask_query_params, mask_headers, mask_body_fields, updated_at;
