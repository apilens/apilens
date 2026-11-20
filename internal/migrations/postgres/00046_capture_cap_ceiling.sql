-- The largest body cap a capture policy may set is now the operator's
-- ingest.max_payload_bytes_limit (1 MiB by default) instead of a fixed
-- 1 MiB, so the column only requires a positive value; the service validates
-- the ceiling. max_payload_bytes NULL means the server default (64 KiB).

-- +goose Up
ALTER TABLE capture_policies DROP CONSTRAINT IF EXISTS capture_policies_max_payload_bytes_check;
ALTER TABLE capture_policies ADD CONSTRAINT capture_policies_max_payload_bytes_check CHECK (max_payload_bytes >= 1);

-- +goose Down
UPDATE capture_policies SET max_payload_bytes = 1048576 WHERE max_payload_bytes > 1048576;
ALTER TABLE capture_policies DROP CONSTRAINT IF EXISTS capture_policies_max_payload_bytes_check;
ALTER TABLE capture_policies ADD CONSTRAINT capture_policies_max_payload_bytes_check CHECK (max_payload_bytes BETWEEN 1 AND 1048576);
