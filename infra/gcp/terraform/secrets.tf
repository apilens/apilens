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
