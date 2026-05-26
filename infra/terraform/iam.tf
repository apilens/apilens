# ────────────────────────────────────────────────────────────────────
# Backend runtime: secret access + logs.
# (No cloudsql.client role — Postgres lives at Supabase and is reached
# over the public internet with sslmode=require, not via Cloud SQL Auth Proxy.)
# ────────────────────────────────────────────────────────────────────

# Keys are static strings so for_each can plan before apply; values are the
# secret resource IDs (known only after apply, which is fine for the values).
locals {
  backend_secret_ids = {
    django_secret_key = google_secret_manager_secret.django_secret_key.id
    database_url      = google_secret_manager_secret.database_url.id
    clickhouse_url    = google_secret_manager_secret.clickhouse_url.id
  }
}

resource "google_secret_manager_secret_iam_member" "backend_secrets" {
  for_each  = local.backend_secret_ids
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.backend_runtime.email}"
}

resource "google_project_iam_member" "backend_logs" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.backend_runtime.email}"
}

# ────────────────────────────────────────────────────────────────────
# Frontend runtime: just the session-secret + logs.
# ────────────────────────────────────────────────────────────────────

resource "google_secret_manager_secret_iam_member" "frontend_session_secret" {
  secret_id = google_secret_manager_secret.session_secret.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.frontend_runtime.email}"
}

resource "google_project_iam_member" "frontend_logs" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.frontend_runtime.email}"
}

# ────────────────────────────────────────────────────────────────────
# GitHub deploy SA: push images, deploy Cloud Run, actAs each runtime SA.
# ────────────────────────────────────────────────────────────────────

resource "google_project_iam_member" "deploy_run_admin" {
  project = var.project_id
  role    = "roles/run.admin"
  member  = "serviceAccount:${google_service_account.github_deploy.email}"
}

resource "google_project_iam_member" "deploy_artifact_writer" {
  project = var.project_id
  role    = "roles/artifactregistry.writer"
  member  = "serviceAccount:${google_service_account.github_deploy.email}"
}

# `actAs` is required for `gcloud run deploy --service-account=...`.
resource "google_service_account_iam_member" "deploy_acts_as_backend" {
  service_account_id = google_service_account.backend_runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.github_deploy.email}"
}

resource "google_service_account_iam_member" "deploy_acts_as_frontend" {
  service_account_id = google_service_account.frontend_runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.github_deploy.email}"
}
