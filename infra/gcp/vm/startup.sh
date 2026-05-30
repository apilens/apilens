#!/usr/bin/env bash
# ============================================================================
# APILens VM bootstrap — runs on EVERY boot, idempotently.
#
# Responsibilities:
#   - mount the persistent data disk at /mnt/data
#   - install docker
#   - pull config (compose, Caddyfile, deploy.sh) from instance metadata
#   - pull secrets from Secret Manager and write /opt/apilens/.env
#   - install + (re)start the apilens systemd unit which runs docker compose
# ============================================================================
set -euo pipefail

# Tee all output to a log for debugging (serial console + file).
exec > >(tee -a /var/log/apilens-startup.log) 2>&1
echo "=== apilens startup.sh @ $(date -u) ==="

# ----------------------------------------------------------------------------
# Metadata helpers
# ----------------------------------------------------------------------------
META="http://metadata.google.internal/computeMetadata/v1"
meta() { curl -s -H "Metadata-Flavor: Google" "${META}/$1"; }
attr() { meta "instance/attributes/$1"; }

PROJECT_ID="$(attr apilens-project-id)"
REGISTRY_HOST="$(attr apilens-registry-host)"
REGISTRY_BASE="$(attr apilens-registry-base)"
IMAGE_TAG="$(attr apilens-image-tag)"
SITE_ADDRESS="$(attr apilens-site-address)"
ALLOWED_HOSTS="$(attr apilens-allowed-hosts)"
DJANGO_SECRET_ID="$(attr apilens-django-secret-id)"
SESSION_SECRET_ID="$(attr apilens-session-secret-id)"
PG_SECRET_ID="$(attr apilens-pg-secret-id)"
CH_SECRET_ID="$(attr apilens-ch-secret-id)"

EXTERNAL_IP="$(meta 'instance/network-interfaces/0/access-configs/0/external-ip')"

# Frontend URL: HTTPS if a domain is set, else HTTP on the external IP.
if [[ "${SITE_ADDRESS}" == :* ]]; then
  FRONTEND_URL="http://${EXTERNAL_IP}"
else
  FRONTEND_URL="https://${SITE_ADDRESS}"
fi

# GCS media bucket name matches the terraform resource: "<project>-media".
# The Django app reads it from GS_BUCKET_NAME (apps/api config/settings.py).
MEDIA_BUCKET="${PROJECT_ID}-media"

# ----------------------------------------------------------------------------
# Base tooling
# ----------------------------------------------------------------------------
if ! command -v jq >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y jq curl
fi

# ----------------------------------------------------------------------------
# Persistent data disk
# ----------------------------------------------------------------------------
DATA_DEV="/dev/disk/by-id/google-apilens-data"
if [[ -b "${DATA_DEV}" ]]; then
  if ! blkid "${DATA_DEV}" >/dev/null 2>&1; then
    echo "Formatting data disk ${DATA_DEV} (ext4)"
    mkfs.ext4 -F "${DATA_DEV}"
  fi
  mkdir -p /mnt/data
  if ! mountpoint -q /mnt/data; then
    mount "${DATA_DEV}" /mnt/data
  fi
  DATA_UUID="$(blkid -s UUID -o value "${DATA_DEV}")"
  if ! grep -q "${DATA_UUID}" /etc/fstab; then
    echo "UUID=${DATA_UUID} /mnt/data ext4 discard,defaults,nofail 0 2" >> /etc/fstab
  fi
else
  echo "WARNING: data disk ${DATA_DEV} not found; using boot disk for /mnt/data"
  mkdir -p /mnt/data
fi

mkdir -p /mnt/data/postgres /mnt/data/clickhouse /mnt/data/redis \
         /mnt/data/caddy/data /mnt/data/caddy/config
# The alpine ClickHouse image runs as uid 101 and refuses to start if its data
# dir is owned by another user (e.g. root, from an earlier boot). Keep it owned
# by 101 every boot so a VM/disk recreate can't wedge ClickHouse.
chown -R 101:101 /mnt/data/clickhouse 2>/dev/null || true

# ----------------------------------------------------------------------------
# Docker
# ----------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  echo "Installing docker"
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

# ----------------------------------------------------------------------------
# Authenticate docker to Artifact Registry via the VM's SA token
# ----------------------------------------------------------------------------
get_token() {
  meta "instance/service-accounts/default/token" | jq -r .access_token
}
get_token | docker login -u oauth2accesstoken --password-stdin "https://${REGISTRY_HOST}"

# ----------------------------------------------------------------------------
# Secret Manager
# ----------------------------------------------------------------------------
access_secret() {
  local secret_id="$1"
  local token
  token="$(get_token)"
  curl -s -H "Authorization: Bearer ${token}" \
    "https://secretmanager.googleapis.com/v1/projects/${PROJECT_ID}/secrets/${secret_id}/versions/latest:access" \
    | jq -r '.payload.data' | base64 -d
}

DJANGO_SECRET_KEY="$(access_secret "${DJANGO_SECRET_ID}")"
SESSION_SECRET="$(access_secret "${SESSION_SECRET_ID}")"
POSTGRES_PASSWORD="$(access_secret "${PG_SECRET_ID}")"
CLICKHOUSE_PASSWORD="$(access_secret "${CH_SECRET_ID}")"

# ----------------------------------------------------------------------------
# App directory + config files (from metadata)
# ----------------------------------------------------------------------------
mkdir -p /opt/apilens /opt/apilens/postgres-init /opt/apilens/clickhouse-config

attr apilens-compose > /opt/apilens/docker-compose.prod.yml
attr apilens-caddy   > /opt/apilens/Caddyfile
attr apilens-deploy  > /opt/apilens/deploy.sh
chmod +x /opt/apilens/deploy.sh

# ClickHouse drop-in: bind IPv4. The image defaults to listening only on [::]
# (IPv6), which fails on this host because IPv6 is disabled, leaving ClickHouse
# bound to nothing. Forcing 0.0.0.0 makes 8123 (HTTP) + 9000 (native) reachable.
# If docker previously auto-created the mount target as a directory (happens when
# the container starts before this file exists), drop it so we can write a file.
rm -rf /opt/apilens/clickhouse-config/listen.xml
cat > /opt/apilens/clickhouse-config/listen.xml <<'XML'
<clickhouse>
    <listen_host>0.0.0.0</listen_host>
</clickhouse>
XML

cat > /opt/apilens/postgres-init/init.sql <<'SQL'
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
SQL

# ----------------------------------------------------------------------------
# .env (locked down)
# ----------------------------------------------------------------------------
(
  umask 077
  cat > /opt/apilens/.env <<ENV
REGISTRY_BASE=${REGISTRY_BASE}
IMAGE_TAG=${IMAGE_TAG}
SITE_ADDRESS=${SITE_ADDRESS}
DJANGO_ALLOWED_HOSTS=${ALLOWED_HOSTS}
FRONTEND_URL=${FRONTEND_URL}
MEDIA_BUCKET=${MEDIA_BUCKET}
GS_PROJECT_ID=${PROJECT_ID}
DJANGO_SECRET_KEY=${DJANGO_SECRET_KEY}
SESSION_SECRET=${SESSION_SECRET}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
CLICKHOUSE_PASSWORD=${CLICKHOUSE_PASSWORD}
ENV
)

# ----------------------------------------------------------------------------
# systemd unit
# ----------------------------------------------------------------------------
cat > /etc/systemd/system/apilens.service <<'UNIT'
[Unit]
Description=APILens single-VM stack (docker compose)
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/apilens
ExecStart=/usr/bin/docker compose -f docker-compose.prod.yml up -d --remove-orphans
ExecStop=/usr/bin/docker compose -f docker-compose.prod.yml down

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable apilens.service

# ----------------------------------------------------------------------------
# Pull latest images and (re)start the stack
# ----------------------------------------------------------------------------
cd /opt/apilens
docker compose -f docker-compose.prod.yml pull || true
systemctl restart apilens.service

echo "=== apilens startup.sh done @ $(date -u) ==="
