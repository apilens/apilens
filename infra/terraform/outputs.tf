output "backend_service_url" {
  description = "Public URL of the backend Cloud Run service"
  value       = google_cloud_run_v2_service.backend.uri
}

output "frontend_service_url" {
  description = "Public URL of the frontend Cloud Run service"
  value       = google_cloud_run_v2_service.frontend.uri
}

output "artifact_registry_path" {
  description = "Base path for pushing container images"
  value       = local.artifact_registry_base
}

output "backend_image_path" {
  description = "Repository path for backend image tags"
  value       = local.backend_image_path
}

output "frontend_image_path" {
  description = "Repository path for frontend image tags"
  value       = local.frontend_image_path
}

output "backend_service_name" {
  description = "Cloud Run service name for the backend (used by deploy workflow)"
  value       = google_cloud_run_v2_service.backend.name
}

output "frontend_service_name" {
  description = "Cloud Run service name for the frontend (used by deploy workflow)"
  value       = google_cloud_run_v2_service.frontend.name
}

output "workload_identity_provider" {
  description = "Full WIF provider resource name — set as GitHub repo secret GCP_WIF_PROVIDER"
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "github_deploy_sa_email" {
  description = "Service account impersonated by GitHub Actions — set as GCP_DEPLOY_SA_EMAIL"
  value       = google_service_account.github_deploy.email
}

output "backend_runtime_sa_email" {
  description = "Backend Cloud Run runtime service account email"
  value       = google_service_account.backend_runtime.email
}

output "frontend_runtime_sa_email" {
  description = "Frontend Cloud Run runtime service account email"
  value       = google_service_account.frontend_runtime.email
}

output "github_secrets_to_set" {
  description = "Map you can paste into `gh secret set` after a first apply"
  value = {
    GCP_PROJECT_ID          = var.project_id
    GCP_REGION              = var.region
    GCP_WIF_PROVIDER        = google_iam_workload_identity_pool_provider.github.name
    GCP_DEPLOY_SA_EMAIL     = google_service_account.github_deploy.email
    GCP_BACKEND_RUNTIME_SA  = google_service_account.backend_runtime.email
    GCP_FRONTEND_RUNTIME_SA = google_service_account.frontend_runtime.email
    GCP_BACKEND_SERVICE     = google_cloud_run_v2_service.backend.name
    GCP_FRONTEND_SERVICE    = google_cloud_run_v2_service.frontend.name
    GCP_BACKEND_IMAGE_PATH  = local.backend_image_path
    GCP_FRONTEND_IMAGE_PATH = local.frontend_image_path
  }
}
