# Global HTTPS Load Balancer in front of both Cloud Run services.
#
# Why we need this: `asia-south1` does not support Cloud Run's native
# domain mappings (GCP UNIMPLEMENTED in this region). The supported path
# for custom domains is a Global External HTTPS LB with serverless NEGs
# pointing at the Cloud Run services, plus a Google-managed SSL cert.
#
# Routing (host-based):
#   app.apilens.ai → apilens-prod-frontend
#   api.apilens.ai → apilens-prod-backend
#
# Apex (apilens.ai) is intentionally NOT mapped here — that's the marketing
# site at Vercel (apilens-website).

# Reserved global IPv4 address — what the user points DNS A records at.
resource "google_compute_global_address" "lb_ip" {
  name = "${local.name_prefix}-lb-ip"
}

# Serverless NEGs (one per Cloud Run service).
resource "google_compute_region_network_endpoint_group" "backend_neg" {
  name                  = "${local.name_prefix}-backend-neg"
  network_endpoint_type = "SERVERLESS"
  region                = var.region

  cloud_run {
    service = google_cloud_run_v2_service.backend.name
  }
}

resource "google_compute_region_network_endpoint_group" "frontend_neg" {
  name                  = "${local.name_prefix}-frontend-neg"
  network_endpoint_type = "SERVERLESS"
  region                = var.region

  cloud_run {
    service = google_cloud_run_v2_service.frontend.name
  }
}

# Backend services wrap each NEG so the URL map can route to them.
# `enable_cdn = false` because both endpoints are dynamic (Django + Next.js
# server). Turn on per-route caching later if/when we have static assets to
# accelerate.
resource "google_compute_backend_service" "backend_api" {
  name                  = "${local.name_prefix}-backend-svc"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  enable_cdn            = false

  backend {
    group = google_compute_region_network_endpoint_group.backend_neg.id
  }
}

resource "google_compute_backend_service" "frontend_app" {
  name                  = "${local.name_prefix}-frontend-svc"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  enable_cdn            = false

  backend {
    group = google_compute_region_network_endpoint_group.frontend_neg.id
  }
}

# Google-managed SSL certificate — covers both subdomains.
# Provisioning takes 15–60 minutes AFTER DNS A records are in place (Google
# validates via HTTP-01 on the LB IP).
resource "google_compute_managed_ssl_certificate" "apilens" {
  name = "${local.name_prefix}-cert"

  managed {
    domains = [
      "app.apilens.ai",
      "api.apilens.ai",
    ]
  }
}

# Host-based URL map.
resource "google_compute_url_map" "apilens" {
  name = "${local.name_prefix}-urlmap"

  # default_service is the fallback — anything that doesn't match a host
  # rule lands on the frontend. Keeps stray hits from 404-ing at the LB.
  default_service = google_compute_backend_service.frontend_app.id

  host_rule {
    hosts        = ["app.apilens.ai"]
    path_matcher = "frontend"
  }

  host_rule {
    hosts        = ["api.apilens.ai"]
    path_matcher = "backend"
  }

  path_matcher {
    name            = "frontend"
    default_service = google_compute_backend_service.frontend_app.id
  }

  path_matcher {
    name            = "backend"
    default_service = google_compute_backend_service.backend_api.id
  }
}

# HTTPS proxy + forwarding rule on :443.
resource "google_compute_target_https_proxy" "apilens" {
  name             = "${local.name_prefix}-https-proxy"
  url_map          = google_compute_url_map.apilens.id
  ssl_certificates = [google_compute_managed_ssl_certificate.apilens.id]
}

resource "google_compute_global_forwarding_rule" "https" {
  name                  = "${local.name_prefix}-https-fr"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  port_range            = "443"
  target                = google_compute_target_https_proxy.apilens.id
  ip_address            = google_compute_global_address.lb_ip.address
}

# Plain :80 forwarder that 301-redirects everything to https://.
resource "google_compute_url_map" "http_redirect" {
  name = "${local.name_prefix}-http-redirect"

  default_url_redirect {
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    https_redirect         = true
    strip_query            = false
  }
}

resource "google_compute_target_http_proxy" "redirect" {
  name    = "${local.name_prefix}-http-proxy"
  url_map = google_compute_url_map.http_redirect.id
}

resource "google_compute_global_forwarding_rule" "http" {
  name                  = "${local.name_prefix}-http-fr"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  port_range            = "80"
  target                = google_compute_target_http_proxy.redirect.id
  ip_address            = google_compute_global_address.lb_ip.address
}
