locals {
  name_prefix = "apilens-${var.environment}"

  artifact_registry_host = "${var.region}-docker.pkg.dev"
  artifact_registry_base = "${local.artifact_registry_host}/${var.project_id}/apilens"
  backend_image_path     = "${local.artifact_registry_base}/backend"
  frontend_image_path    = "${local.artifact_registry_base}/frontend"

  # Caddy site addresses. With no app_domain we serve plain HTTP on the IP
  # (":80"); with one, Caddy auto-issues a Let's Encrypt cert for that host.
  app_site = var.app_domain != "" ? var.app_domain : ":80"
  api_site = var.api_domain

  # Django ALLOWED_HOSTS + CSRF/CORS origins derived from the domains. Internal
  # service names (api/web) and loopback are appended in startup.sh.
  allowed_hosts = join(",", compact([
    var.app_domain,
    var.api_domain,
    var.backend_allowed_hosts,
  ]))

  csrf_trusted_origins = join(",", compact([
    var.app_domain != "" ? "https://${var.app_domain}" : "",
    var.api_domain != "" ? "https://${var.api_domain}" : "",
  ]))
}
