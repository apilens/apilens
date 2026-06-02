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

  # WebAuthn / passkey Relying Party ID. The RP ID must equal the page's domain
  # OR a registrable parent of it. We use the registrable parent of app_domain
  # (e.g. app.apilens.ai -> apilens.ai) so one passkey works across the app,
  # api and docs subdomains. For a 2-label domain (example.com) or an explicit
  # override, use it as-is. Empty app_domain falls back to "localhost" for dev.
  _app_labels = var.app_domain != "" ? split(".", var.app_domain) : []
  webauthn_rp_id = (
    var.webauthn_rp_id != "" ? var.webauthn_rp_id :
    var.app_domain == "" ? "localhost" :
    length(local._app_labels) > 2 ? join(".", slice(local._app_labels, 1, length(local._app_labels))) :
    var.app_domain
  )
}
