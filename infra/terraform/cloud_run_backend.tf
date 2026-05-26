resource "google_cloud_run_v2_service" "backend" {
  name     = "${local.name_prefix}-backend"
  location = var.region

  # Drop unauthenticated requests at the LB; we open it up explicitly below.
  ingress = "INGRESS_TRAFFIC_ALL"

  # Keep destroy paths in Terraform's hands. Flip to true if you want a UI
  # safety net against accidental `terraform destroy`.
  deletion_protection = false

  template {
    service_account = google_service_account.backend_runtime.email

    scaling {
      min_instance_count = 0
      max_instance_count = 5
    }

    containers {
      image = local.placeholder_image

      ports {
        container_port = 8000
      }

      env {
        name  = "DJANGO_DEBUG"
        value = "False"
      }

      env {
        name  = "DJANGO_ALLOWED_HOSTS"
        value = var.backend_allowed_hosts
      }

      # PORT is set automatically by Cloud Run (matches container_port below).
      # Gunicorn reads $PORT in scripts/start.sh.

      env {
        name  = "GUNICORN_WORKERS"
        value = "2"
      }

      # Frontend URL is wired by the deploy workflow at deploy time (it can't be
      # known here without a circular reference to the frontend service).
      # Default keeps email-template links well-formed if the workflow forgets.
      env {
        name  = "FRONTEND_URL"
        value = var.frontend_url
      }

      env {
        name = "DJANGO_SECRET_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.django_secret_key.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "APILENS_DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.database_url.secret_id
            version = "latest"
          }
        }
      }

      env {
        name = "APILENS_CLICKHOUSE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.clickhouse_url.secret_id
            version = "latest"
          }
        }
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle = true
      }

      startup_probe {
        tcp_socket {
          port = 8000
        }
        initial_delay_seconds = 10
        period_seconds        = 5
        timeout_seconds       = 3
        # Cold start = container pull + gunicorn boot + (first-time) migrations.
        # Generous threshold so we don't kill healthy instances during scale-up.
        failure_threshold = 30
      }
    }
  }

  lifecycle {
    # Image revisions are managed by the deploy workflow; Terraform shouldn't
    # roll back a freshly-deployed image just because the .tf hasn't moved.
    # The whole template containers block is ignored because the deploy workflow
    # also injects FRONTEND_URL (set to the live frontend Cloud Run URL) and we
    # don't want apply to reset that to the variable default.
    ignore_changes = [
      template[0].containers,
      client,
      client_version,
    ]
  }

  depends_on = [
    google_secret_manager_secret_iam_member.backend_secrets,
  ]
}

# Public access — required for browser-side SDK use + dashboard logins.
# Auth is handled by Django/JWT at the application layer.
resource "google_cloud_run_v2_service_iam_member" "backend_public" {
  project  = google_cloud_run_v2_service.backend.project
  location = google_cloud_run_v2_service.backend.location
  name     = google_cloud_run_v2_service.backend.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
