# ────────────────────────────────────────────────────────────────────
# Backend runtime: secret access, Cloud SQL, logs.
# ────────────────────────────────────────────────────────────────────

locals {
  backend_secret_ids = [
    google_secret_manager_secret.django_secret_key.id,
    google_secret_manager_secret.database_url.id,
    google_secret_manager_secret.clickhouse_url.id,
  ]
}

resource "google_secret_manager_secret_iam_member" "backend_secrets" {
  for_each  = toset(local.backend_secret_ids)
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.backend_runtime.email}"
}

resource "google_project_iam_member" "backend_cloudsql" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.backend_runtime.email}"
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
