locals {
  name_prefix = "apilens-${var.environment}"

  artifact_registry_host = "${var.region}-docker.pkg.dev"
  artifact_registry_base = "${local.artifact_registry_host}/${var.project_id}/apilens"
  backend_image_path     = "${local.artifact_registry_base}/backend"
  frontend_image_path    = "${local.artifact_registry_base}/frontend"

  site_address = var.domain != "" ? var.domain : ":80"
}
