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

# Database URL — Terraform populates the version because it owns the password.
# Backend reads this as APILENS_DATABASE_URL (canonical name in settings.py).
resource "google_secret_manager_secret" "database_url" {
  secret_id = "apilens-database-url"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "database_url" {
  secret = google_secret_manager_secret.database_url.id
  secret_data = format(
    "postgresql://%s:%s@/%s?host=/cloudsql/%s",
    google_sql_user.apilens.name,
    random_password.db_password.result,
    google_sql_database.apilens.name,
    google_sql_database_instance.postgres.connection_name,
  )
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
