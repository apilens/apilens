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
