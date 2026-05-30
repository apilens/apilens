output "instance_name" {
  description = "Name of the all-in-one Compute Engine VM"
  value       = google_compute_instance.app.name
}
output "instance_zone" {
  description = "Zone the VM runs in"
  value       = google_compute_instance.app.zone
}
output "instance_ip" {
  description = "Static external IP of the VM. Point your domain's A record here."
  value       = google_compute_address.app.address
}
output "app_url" {
  description = "Where the app is reachable once it's up"
  value       = var.domain != "" ? "https://${var.domain}" : "http://${google_compute_address.app.address}"
}
output "ssh_command" {
  description = "SSH onto the VM (via IAP)"
  value       = "gcloud compute ssh ${google_compute_instance.app.name} --zone ${var.zone} --tunnel-through-iap --project ${var.project_id}"
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
output "vm_runtime_sa_email" {
  description = "Service account the VM runs as"
  value       = google_service_account.vm_runtime.email
}
output "github_deploy_sa_email" {
  description = "Service account impersonated by GitHub Actions"
  value       = google_service_account.github_deploy.email
}
output "workload_identity_provider" {
  description = "Full WIF provider resource name"
  value       = google_iam_workload_identity_pool_provider.github.name
}
output "github_secrets_to_set" {
  description = "Map you can paste into `gh secret set` after a first apply"
  value = {
    GCP_PROJECT_ID          = var.project_id
    GCP_REGION              = var.region
    GCP_ZONE                = var.zone
    GCP_WIF_PROVIDER        = google_iam_workload_identity_pool_provider.github.name
    GCP_DEPLOY_SA_EMAIL     = google_service_account.github_deploy.email
    GCP_VM_NAME             = google_compute_instance.app.name
    GCP_BACKEND_IMAGE_PATH  = local.backend_image_path
    GCP_FRONTEND_IMAGE_PATH = local.frontend_image_path
  }
}
