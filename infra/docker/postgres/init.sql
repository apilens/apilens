-- Postgres bootstrap for local dev.
-- The `apilens` database + user are created by the POSTGRES_* env vars in
-- compose; this script just adds extensions Django needs.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
