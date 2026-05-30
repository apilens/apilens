#!/usr/bin/env bash
# ============================================================================
# APILens VM deploy — pull new images and roll the stack.
#
# Invoked by the GitHub Actions deploy workflow over IAP SSH as:
#   sudo /opt/apilens/deploy.sh <image-tag>
#
# With no arg it just re-pulls whatever IMAGE_TAG is already in .env.
# ============================================================================
set -euo pipefail

APP_DIR="/opt/apilens"
COMPOSE_FILE="${APP_DIR}/docker-compose.prod.yml"
ENV_FILE="${APP_DIR}/.env"

IMAGE_TAG="${1:-}"

META="http://metadata.google.internal/computeMetadata/v1"
meta() { curl -s -H "Metadata-Flavor: Google" "${META}/$1"; }

REGISTRY_HOST="$(meta 'instance/attributes/apilens-registry-host')"

# Re-authenticate docker to Artifact Registry using the VM's SA token.
meta 'instance/service-accounts/default/token' \
  | jq -r .access_token \
  | docker login -u oauth2accesstoken --password-stdin "https://${REGISTRY_HOST}"

# If a tag was passed, pin it in .env so restarts/reboots stay consistent.
if [[ -n "${IMAGE_TAG}" ]]; then
  if grep -q '^IMAGE_TAG=' "${ENV_FILE}"; then
    sed -i "s|^IMAGE_TAG=.*|IMAGE_TAG=${IMAGE_TAG}|" "${ENV_FILE}"
  else
    echo "IMAGE_TAG=${IMAGE_TAG}" >> "${ENV_FILE}"
  fi
fi

cd "${APP_DIR}"
docker compose -f "${COMPOSE_FILE}" pull
docker compose -f "${COMPOSE_FILE}" up -d --remove-orphans
docker image prune -f

echo "Deploy complete (IMAGE_TAG=${IMAGE_TAG:-unchanged})"
