variable "project_id" {
  description = "GCP project ID hosting all APILens resources"
  type        = string
}

variable "project_number" {
  description = "GCP project number (numeric). Needed for some IAM member references."
  type        = string
}

variable "region" {
  description = "Region for the VM, Artifact Registry, and the media bucket"
  type        = string
  default     = "us-central1"
}

variable "zone" {
  description = "Zone for the VM and its data disk. Must live inside var.region."
  type        = string
  default     = "us-central1-a"
}

variable "environment" {
  description = "Logical environment baked into resource names (prod, staging, ...)"
  type        = string
  default     = "prod"
}

variable "github_repo" {
  description = "`owner/name` of the GitHub repo allowed to impersonate the deploy SA"
  type        = string
}

variable "machine_type" {
  description = "Compute Engine machine type for the all-in-one VM (8 vCPU / 32 GB default)."
  type        = string
  default     = "e2-standard-8"
}

variable "boot_disk_size" {
  description = "Boot disk size in GB (OS + docker images + container layers)."
  type        = number
  default     = 40
}

variable "boot_disk_type" {
  description = "Boot disk type. pd-balanced is the sweet spot for price/IO."
  type        = string
  default     = "pd-balanced"
}

variable "data_disk_size" {
  description = "Persistent data disk in GB for Postgres + ClickHouse volumes. Survives VM recreation."
  type        = number
  default     = 100
}

variable "data_disk_type" {
  description = "Data disk type. pd-ssd gives Postgres/ClickHouse the IOPS they want."
  type        = string
  default     = "pd-ssd"
}

variable "vm_image" {
  description = "Boot image family for the VM. Ubuntu LTS keeps docker + tooling simple."
  type        = string
  default     = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
}

variable "ssh_source_ranges" {
  description = "CIDR ranges allowed to reach SSH (port 22). Lock down for prod. IAP SSH always works."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "app_domain" {
  description = <<-EOT
    Public hostname for the app (frontend + /api/* proxied to the backend),
    e.g. "app.apilens.ai". When set, Caddy auto-provisions a Let's Encrypt cert.
    Point this name's DNS A record at the `instance_ip` output FIRST. Empty =
    serve plain HTTP on the raw IP.
  EOT
  type        = string
  default     = ""
}

variable "api_domain" {
  description = <<-EOT
    Optional dedicated hostname for the backend API, e.g. "api.apilens.ai".
    Everything on this host is proxied to Django. Leave empty to serve the API
    only under <app_domain>/api. Requires app_domain to be set.
  EOT
  type        = string
  default     = ""
}

variable "image_tag" {
  description = "Container image tag the VM should run for the api + web images."
  type        = string
  default     = "latest"
}

variable "backend_allowed_hosts" {
  description = "Comma-separated DJANGO_ALLOWED_HOSTS value."
  type        = string
  default     = "*"
}

variable "default_from_email" {
  description = <<-EOT
    From address for transactional email (must be on a Resend-verified domain).
    e.g. "APILens <noreply@apilens.ai>". The Resend API key itself is stored in
    the apilens-resend-api-key secret (set manually post-apply).
  EOT
  type        = string
  default     = "APILens <noreply@apilens.ai>"
}
