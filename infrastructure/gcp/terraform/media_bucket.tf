# GCS bucket for user-uploaded media (profile pictures, app icons).
#
# Public-read so the frontend can `<img src="https://storage.googleapis.com/...">`
# directly — no signed-URL round trip on every page render. URLs are
# unguessable (UUID-based filenames), same privacy model as GitHub/Slack avatars.
#
# Uniform bucket-level access means we control public access via IAM (the
# `allUsers` -> `storage.objectViewer` binding below), not per-object ACLs.

resource "google_storage_bucket" "media" {
  name     = "${var.project_id}-media"
  location = var.region

  uniform_bucket_level_access = true
  public_access_prevention    = "inherited"

  # Don't keep deleted versions around — when an upload is replaced or
  # removed we want it actually gone.
  versioning {
    enabled = false
  }

  # CORS: browser fetches inline from `<img>` tags loaded by the app at
  # app.apilens.ai. Restrict to known origins.
  cors {
    origin          = ["https://app.apilens.ai", "http://localhost:3000"]
    method          = ["GET", "HEAD"]
    response_header = ["*"]
    max_age_seconds = 3600
  }

  # Don't strand orphan resources during dev `terraform destroy`.
  force_destroy = false

  depends_on = [google_project_service.apis]
}

# Anyone can GET objects (the frontend renders them in <img> tags); nobody
# can list or write without authenticated credentials.
resource "google_storage_bucket_iam_member" "media_public_read" {
  bucket = google_storage_bucket.media.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}

# Backend runtime SA writes + deletes objects (upload, replace, remove).
resource "google_storage_bucket_iam_member" "backend_media_admin" {
  bucket = google_storage_bucket.media.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.backend_runtime.email}"
}
