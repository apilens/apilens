terraform {
  required_version = ">= 1.5.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Remote state in GCS. Bucket is supplied via `-backend-config` at init time
  # so this file can stay generic across environments:
  #
  #   terraform init -backend-config="bucket=<project-id>-tfstate"
  backend "gcs" {
    prefix = "apilens/state"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
