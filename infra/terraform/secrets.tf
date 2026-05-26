# Django app secret — set manually post-apply:
#   echo -n "$(openssl rand -base64 64 | tr -d '\n')" | \
#     gcloud secrets versions add django-secret-key --data-file=-
resource "google_secret_manager_secret" "django_secret_key" {
  secret_id = "django-secret-key"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

# Frontend session cookie key (AES-256-GCM). Set manually post-apply:
#   openssl rand -hex 32 | tr -d '\n' | \
#     gcloud secrets versions add session-secret --data-file=-
resource "google_secret_manager_secret" "session_secret" {
  secret_id = "session-secret"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

# Database URL — Postgres lives at Supabase (externally managed). Terraform
# just creates the holder; the user pastes the Supabase connection string
# after apply:
#
#   echo -n 'postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres?sslmode=require' | \
#     gcloud secrets versions add apilens-database-url --data-file=-
#
# Use Supabase's "Connection Pooling" (transaction mode, port 6543) URL — not
# the direct connection on 5432 — because Cloud Run is bursty/serverless and
# benefits from PgBouncer in front of Postgres. sslmode=require is mandatory.
resource "google_secret_manager_secret" "database_url" {
  secret_id = "apilens-database-url"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

# ClickHouse Cloud DSN — provisioned manually outside Terraform:
#   echo -n "https://default:PWD@ID.region.clickhouse.cloud:8443/apilens" | \
#     gcloud secrets versions add apilens-clickhouse-url --data-file=-
resource "google_secret_manager_secret" "clickhouse_url" {
  secret_id = "apilens-clickhouse-url"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}
