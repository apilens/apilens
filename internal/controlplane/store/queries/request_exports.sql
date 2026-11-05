-- name: CreateRequestExport :one
INSERT INTO request_exports (id, project_id, created_by, filter, range_from, range_to, row_limit, signing_key)
VALUES (@id, @project_id, @created_by, @filter, @range_from, @range_to, @row_limit, @signing_key)
RETURNING *;

-- name: GetRequestExport :one
SELECT * FROM request_exports WHERE id = @id;

-- name: StartRequestExport :one
-- Moves a queued (or retried, still running) export to running. No row
-- means it was cancelled or is already done.
UPDATE request_exports
SET status = 'running', started_at = coalesce(started_at, now()), rows_written = 0, error = NULL
WHERE id = @id AND status IN ('queued', 'running')
RETURNING *;

-- name: SetRequestExportTotal :execrows
UPDATE request_exports SET total_rows = @total_rows WHERE id = @id AND status = 'running';

-- name: SetRequestExportProgress :execrows
-- No row means the export was cancelled meanwhile.
UPDATE request_exports SET rows_written = @rows_written WHERE id = @id AND status = 'running';

-- name: CompleteRequestExport :execrows
UPDATE request_exports
SET status = 'completed', rows_written = @rows_written, size_bytes = @size_bytes, file_key = @file_key,
    finished_at = now(), expires_at = @expires_at
WHERE id = @id AND status = 'running';

-- name: FailRequestExport :execrows
UPDATE request_exports
SET status = 'failed', error = @error, finished_at = now()
WHERE id = @id AND status IN ('queued', 'running');

-- name: CancelRequestExport :one
-- Cancels a queued or running export. No row means it already finished.
UPDATE request_exports
SET status = 'cancelled', finished_at = now()
WHERE id = @id AND status IN ('queued', 'running')
RETURNING *;

-- name: ListExpiredRequestExports :many
SELECT * FROM request_exports
WHERE status = 'completed' AND expires_at <= @now::timestamptz
ORDER BY expires_at
LIMIT @max_rows;

-- name: ExpireRequestExport :execrows
UPDATE request_exports SET status = 'expired', file_key = NULL WHERE id = @id AND status = 'completed';
