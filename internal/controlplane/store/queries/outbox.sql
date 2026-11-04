-- name: InsertOutbox :one
-- Transactional outbox (ADR 0006): called only through
-- internal/controlplane/outbox.Emit, in the same transaction as the change
-- the row describes. The relay (#291) reads rows in id order.
INSERT INTO outbox (topic, aggregate_id, payload)
VALUES (@topic, @aggregate_id, @payload)
RETURNING id;

-- name: NotifyOutbox :exec
-- Wakes the relay. A NOTIFY sent inside a transaction is delivered on commit
-- only, and never on rollback.
SELECT pg_notify('outbox', '');

-- name: LockOutboxRelay :exec
-- Serialises relay passes across processes for the rest of the transaction,
-- so rows are applied to SpiceDB strictly in id order.
SELECT pg_advisory_xact_lock(@lock_key::bigint);

-- name: ClaimPendingOutbox :many
-- The relay's batch: the oldest unprocessed rows, locked until its
-- transaction ends.
SELECT id, topic, aggregate_id, payload, created_at
FROM outbox
WHERE processed_at IS NULL
ORDER BY id
LIMIT @batch_size
FOR UPDATE SKIP LOCKED;

-- name: MarkOutboxProcessed :exec
UPDATE outbox SET processed_at = now() WHERE id = @id;

-- name: OutboxLagSeconds :one
-- Age of the oldest unprocessed row, 0 when the outbox is drained.
SELECT COALESCE(EXTRACT(EPOCH FROM now() - min(created_at)), 0)::float8 AS lag
FROM outbox
WHERE processed_at IS NULL;
