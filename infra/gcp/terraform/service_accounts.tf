resource "google_service_account" "vm_runtime" {
  account_id   = "${local.name_prefix}-vm"
  display_name = "APILens all-in-one VM runtime"
}

resource "google_service_account" "github_deploy" {
  account_id   = "${local.name_prefix}-github-deploy"
  display_name = "GitHub Actions deploy SA for APILens"
}
