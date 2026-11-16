-- API key rotation with an overlap window (#781, Stripe "roll key").
--
--   rotated_to    the key that replaced this one. Set when the key is
--                 rotated, together with an expires_at at most the overlap
--                 window (none, 24 h, 7 d) away, so the old secret keeps
--                 working while deploys pick up the new one. A key with
--                 rotated_to set cannot be rotated again.
--   rotated_from  the key this one replaced; set on the successor when it
--                 is created by a rotation.
--
-- Both point into api_keys of the same project and are only ever set once,
-- so a key's predecessors and successors can be followed in either
-- direction from the list response.

-- +goose Up
ALTER TABLE api_keys
    ADD COLUMN IF NOT EXISTS rotated_from uuid REFERENCES api_keys (id),
    ADD COLUMN IF NOT EXISTS rotated_to   uuid REFERENCES api_keys (id);

-- +goose Down
ALTER TABLE api_keys
    DROP COLUMN IF EXISTS rotated_to,
    DROP COLUMN IF EXISTS rotated_from;
