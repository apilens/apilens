variable "project_id" {
  description = "GCP project ID hosting all APILens resources"
  type        = string
}

variable "project_number" {
  description = "GCP project number (numeric). Needed for some IAM member references."
  type        = string
}

variable "region" {
  description = "Region for Cloud Run, Cloud SQL, and Artifact Registry"
  type        = string
  default     = "us-central1"
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

variable "db_tier" {
  description = "Cloud SQL machine tier. db-f1-micro is the cheapest; bump for prod load."
  type        = string
  default     = "db-f1-micro"
}

variable "db_deletion_protection" {
  description = "Cloud SQL deletion protection. Disable only when intentionally tearing down."
  type        = bool
  default     = true
}

variable "backend_allowed_hosts" {
  description = "Comma-separated DJANGO_ALLOWED_HOSTS value. .run.app covers Cloud Run defaults."
  type        = string
  default     = ".run.app,.apilens.ai"
}

variable "frontend_url" {
  description = "Canonical frontend origin written to FRONTEND_URL on the backend."
  type        = string
  default     = ""
}
