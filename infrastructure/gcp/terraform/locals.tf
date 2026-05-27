locals {
  name_prefix = "apilens-${var.environment}"

  # Used until the first real image lands in Artifact Registry.
  placeholder_image = "gcr.io/cloudrun/hello"

  artifact_registry_base = "${var.region}-docker.pkg.dev/${var.project_id}/apilens"
  backend_image_path     = "${local.artifact_registry_base}/backend"
  frontend_image_path    = "${local.artifact_registry_base}/frontend"
}
