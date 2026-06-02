# Keyed by static names (not the secrets' apply-time IDs) so for_each is
# resolvable at plan time. The value is the secret_id each member binds to.
locals {
  vm_secret_ids = {
    django_secret_key   = google_secret_manager_secret.django_secret_key.secret_id
    session_secret      = google_secret_manager_secret.session_secret.secret_id
    postgres_password   = google_secret_manager_secret.postgres_password.secret_id
    clickhouse_password = google_secret_manager_secret.clickhouse_password.secret_id
    resend_api_key      = google_secret_manager_secret.resend_api_key.secret_id
    sentry_dsn          = google_secret_manager_secret.sentry_dsn.secret_id
  }
}

resource "google_secret_manager_secret_iam_member" "vm_secrets" {
  for_each  = local.vm_secret_ids
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.vm_runtime.email}"
}

resource "google_project_iam_member" "vm_artifact_reader" {
  project = var.project_id
  role    = "roles/artifactregistry.reader"
  member  = "serviceAccount:${google_service_account.vm_runtime.email}"
}

resource "google_storage_bucket_iam_member" "vm_media_admin" {
  bucket = google_storage_bucket.media.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.vm_runtime.email}"
}

resource "google_project_iam_member" "vm_logs" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.vm_runtime.email}"
}

resource "google_project_iam_member" "vm_metrics" {
  project = var.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.vm_runtime.email}"
}

resource "google_project_iam_member" "deploy_artifact_writer" {
  project = var.project_id
  role    = "roles/artifactregistry.writer"
  member  = "serviceAccount:${google_service_account.github_deploy.email}"
}

resource "google_project_iam_member" "deploy_compute_admin" {
  project = var.project_id
  role    = "roles/compute.instanceAdmin.v1"
  member  = "serviceAccount:${google_service_account.github_deploy.email}"
}

resource "google_project_iam_member" "deploy_os_login" {
  project = var.project_id
  role    = "roles/compute.osAdminLogin"
  member  = "serviceAccount:${google_service_account.github_deploy.email}"
}

resource "google_project_iam_member" "deploy_iap" {
  project = var.project_id
  role    = "roles/iap.tunnelResourceAccessor"
  member  = "serviceAccount:${google_service_account.github_deploy.email}"
}

resource "google_service_account_iam_member" "deploy_acts_as_vm" {
  service_account_id = google_service_account.vm_runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.github_deploy.email}"
}
