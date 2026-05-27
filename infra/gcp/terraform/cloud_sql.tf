resource "random_password" "db_password" {
  length  = 32
  # Skip special chars so the password can sit in a URL without percent-encoding.
  special = false
}

resource "google_sql_database_instance" "postgres" {
  name             = "${local.name_prefix}-pg"
  database_version = "POSTGRES_16"
  region           = var.region

  deletion_protection = var.db_deletion_protection

  settings {
    tier              = var.db_tier
    availability_type = "ZONAL" # bump to REGIONAL for HA when it matters
    disk_size         = 10
    disk_autoresize   = true

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      start_time                     = "03:00"
      transaction_log_retention_days = 7
    }

    ip_configuration {
      # Public IP is OK because Cloud Run connects via the Cloud SQL Auth Proxy
      # over a unix socket, never directly. SSL-only enforced below.
      ipv4_enabled = true
      ssl_mode     = "ENCRYPTED_ONLY"
    }

    database_flags {
      name  = "max_connections"
      value = "100"
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_sql_database" "apilens" {
  name     = "apilens"
  instance = google_sql_database_instance.postgres.name
}

resource "google_sql_user" "apilens" {
  name     = "apilens"
  instance = google_sql_database_instance.postgres.name
  password = random_password.db_password.result
}
