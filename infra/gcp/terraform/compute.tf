resource "google_compute_disk" "data" {
  name = "${local.name_prefix}-data"
  type = var.data_disk_type
  zone = var.zone
  size = var.data_disk_size
  lifecycle {
    prevent_destroy = true
  }
  depends_on = [google_project_service.apis]
}

resource "google_compute_instance" "app" {
  name         = "${local.name_prefix}-app"
  machine_type = var.machine_type
  zone         = var.zone
  tags         = ["apilens"]

  boot_disk {
    initialize_params {
      image = var.vm_image
      size  = var.boot_disk_size
      type  = var.boot_disk_type
    }
  }

  attached_disk {
    source      = google_compute_disk.data.id
    device_name = "apilens-data"
  }

  network_interface {
    subnetwork = google_compute_subnetwork.subnet.id
    access_config {
      nat_ip = google_compute_address.app.address
    }
  }

  service_account {
    email  = google_service_account.vm_runtime.email
    scopes = ["cloud-platform"]
  }

  allow_stopping_for_update = true

  metadata = {
    enable-oslogin              = "TRUE"
    "apilens-project-id"        = var.project_id
    "apilens-registry-host"     = local.artifact_registry_host
    "apilens-registry-base"     = local.artifact_registry_base
    "apilens-image-tag"         = var.image_tag
    "apilens-app-site"          = local.app_site
    "apilens-api-site"          = local.api_site
    "apilens-allowed-hosts"     = local.allowed_hosts
    "apilens-csrf-origins"      = local.csrf_trusted_origins
    "apilens-django-secret-id"  = google_secret_manager_secret.django_secret_key.secret_id
    "apilens-session-secret-id" = google_secret_manager_secret.session_secret.secret_id
    "apilens-pg-secret-id"      = google_secret_manager_secret.postgres_password.secret_id
    "apilens-ch-secret-id"      = google_secret_manager_secret.clickhouse_password.secret_id
    "apilens-compose"           = file("${path.module}/../vm/docker-compose.prod.yml")
    "apilens-caddy"             = file("${path.module}/../vm/Caddyfile")
    "apilens-deploy"            = file("${path.module}/../vm/deploy.sh")
    startup-script              = file("${path.module}/../vm/startup.sh")
  }

  depends_on = [
    google_secret_manager_secret_iam_member.vm_secrets,
    google_project_iam_member.vm_artifact_reader,
    google_secret_manager_secret_version.postgres_password,
    google_secret_manager_secret_version.clickhouse_password,
  ]
}
