resource "google_artifact_registry_repository" "apilens" {
  location      = var.region
  repository_id = "apilens"
  description   = "Container images for APILens backend + frontend"
  format        = "DOCKER"

  # Trim old images so storage costs don't grow unbounded. Keeps the 10 most
  # recent tagged revisions per image name; untagged blobs are GC'd after 7d.
  cleanup_policies {
    id     = "keep-recent-10"
    action = "KEEP"
    most_recent_versions {
      keep_count = 10
    }
  }

  cleanup_policies {
    id     = "delete-untagged"
    action = "DELETE"
    condition {
      tag_state  = "UNTAGGED"
      older_than = "604800s" # 7 days
    }
  }

  depends_on = [google_project_service.apis]
}
