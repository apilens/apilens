resource "google_secret_manager_secret" "django_secret_key" {
  secret_id = "apilens-django-secret-key"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "session_secret" {
  secret_id = "apilens-session-secret"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "random_password" "postgres" {
  length  = 32
  special = false
}

resource "google_secret_manager_secret" "postgres_password" {
  secret_id = "apilens-postgres-password"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "postgres_password" {
  secret      = google_secret_manager_secret.postgres_password.id
  secret_data = random_password.postgres.result
}

resource "random_password" "clickhouse" {
  length  = 32
  special = false
}

resource "google_secret_manager_secret" "clickhouse_password" {
  secret_id = "apilens-clickhouse-password"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "clickhouse_password" {
  secret      = google_secret_manager_secret.clickhouse_password.id
  secret_data = random_password.clickhouse.result
}

# Resend API key for transactional email (magic links, verification). Set
# manually post-apply (it's a third-party credential, not generated here):
#   printf %s 're_xxx' | gcloud secrets versions add apilens-resend-api-key --data-file=-
resource "google_secret_manager_secret" "resend_api_key" {
  secret_id = "apilens-resend-api-key"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

# RS256 JWT signing private key (base64 PEM). Created empty; populate the version
# manually post-apply (the keypair is generated out-of-band). No version => the
# backend falls back to HS256 (safe).
resource "google_secret_manager_secret" "jwt_private_key" {
  secret_id = "apilens-jwt-private-key"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

# Shared secret guarding the identity introspection endpoint (ingest -> identity).
# Auto-generated so it's always populated.
resource "random_password" "introspect_secret" {
  length  = 48
  special = false
}

resource "google_secret_manager_secret" "introspect_secret" {
  secret_id = "apilens-introspect-secret"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "introspect_secret" {
  secret      = google_secret_manager_secret.introspect_secret.id
  secret_data = random_password.introspect_secret.result
}
