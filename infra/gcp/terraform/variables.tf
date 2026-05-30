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

variable "domain" {
  description = "Public domain for auto-HTTPS via Caddy. Empty = serve plain HTTP on the IP."
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
