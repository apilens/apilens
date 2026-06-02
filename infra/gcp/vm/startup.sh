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
APP_SITE="$(attr apilens-app-site)"
API_SITE="$(attr apilens-api-site)"
GRAFANA_SITE="$(attr apilens-grafana-site)"
ALLOWED_HOSTS="$(attr apilens-allowed-hosts)"
CSRF_ORIGINS="$(attr apilens-csrf-origins)"
DJANGO_SECRET_ID="$(attr apilens-django-secret-id)"
SESSION_SECRET_ID="$(attr apilens-session-secret-id)"
PG_SECRET_ID="$(attr apilens-pg-secret-id)"
CH_SECRET_ID="$(attr apilens-ch-secret-id)"
RESEND_SECRET_ID="$(attr apilens-resend-secret-id)"
GRAFANA_SECRET_ID="$(attr apilens-grafana-secret-id)"
FROM_EMAIL="$(attr apilens-from-email)"
WEBAUTHN_RP_ID="$(attr apilens-webauthn-rp-id)"
WEBAUTHN_RP_NAME="$(attr apilens-webauthn-rp-name)"

EXTERNAL_IP="$(meta 'instance/network-interfaces/0/access-configs/0/external-ip')"

# Public origin (used for FRONTEND_URL + browser CORS): the app domain over
# HTTPS if one is configured, else plain HTTP on the external IP.
if [[ "${APP_SITE}" == :* || -z "${APP_SITE}" ]]; then
  FRONTEND_URL="http://${EXTERNAL_IP}"
else
  FRONTEND_URL="https://${APP_SITE}"
fi

# Browser CORS origins: the app origin plus localhost for dev tooling.
CORS_ORIGINS="${FRONTEND_URL},http://localhost:3000,http://127.0.0.1:3000"

# Grafana's external root URL: the dedicated HTTPS host when one is configured,
# else the loopback address used by the SSH tunnel. Grafana needs this correct so
# its redirects + asset/cookie URLs match how the browser actually reaches it.
if [[ -n "${GRAFANA_SITE}" ]]; then
  GRAFANA_ROOT_URL="https://${GRAFANA_SITE}"
else
  GRAFANA_ROOT_URL="http://localhost:3001"
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
         /mnt/data/caddy/data /mnt/data/caddy/config \
         /mnt/data/grafana /mnt/data/loki /mnt/data/prometheus /mnt/data/promtail
# The alpine ClickHouse image runs as uid 101 and refuses to start if its data
# dir is owned by another user (e.g. root, from an earlier boot). Keep it owned
# by 101 every boot so a VM/disk recreate can't wedge ClickHouse.
chown -R 101:101 /mnt/data/clickhouse 2>/dev/null || true
# Same fix-ownership-every-boot trick for the observability stores: each image
# drops to a non-root uid and refuses to write a root-owned data dir.
#   grafana -> 472, loki -> 10001, prometheus (nobody) -> 65534
chown -R 472:472 /mnt/data/grafana 2>/dev/null || true
chown -R 10001:10001 /mnt/data/loki 2>/dev/null || true
chown -R 65534:65534 /mnt/data/prometheus 2>/dev/null || true

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
# Resend key may have no version yet on a fresh project; tolerate that so the
# stack still boots (email just no-ops until the secret is populated).
RESEND_API_KEY="$(access_secret "${RESEND_SECRET_ID}" || true)"
# Grafana admin password (terraform generates it; localhost-only UI). Tolerate a
# missing version so the stack still boots — compose falls back to "admin".
GRAFANA_ADMIN_PASSWORD="$(access_secret "${GRAFANA_SECRET_ID}" || true)"

# ----------------------------------------------------------------------------
# App directory + config files (from metadata)
# ----------------------------------------------------------------------------
mkdir -p /opt/apilens /opt/apilens/postgres-init /opt/apilens/clickhouse-config

attr apilens-compose > /opt/apilens/docker-compose.prod.yml
attr apilens-caddy   > /opt/apilens/Caddyfile
attr apilens-deploy  > /opt/apilens/deploy.sh
chmod +x /opt/apilens/deploy.sh

# Append a dedicated api.<domain> site block only when one is configured — an
# empty site label would make Caddy refuse to start. The hostname is written
# literally (not via env) so we never emit an empty "{ ... }" block.
if [[ -n "${API_SITE}" ]]; then
  cat >> /opt/apilens/Caddyfile <<CADDY

${API_SITE} {
	encode gzip zstd
	reverse_proxy api:8000
}
CADDY
fi

# Dedicated Grafana host (auto-HTTPS). Appended only when configured so an empty
# site label can't make Caddy refuse to start. Grafana's own login still gates
# access; the upstream is the in-network container port (grafana:3000).
if [[ -n "${GRAFANA_SITE}" ]]; then
  cat >> /opt/apilens/Caddyfile <<CADDY

${GRAFANA_SITE} {
	encode gzip zstd
	reverse_proxy grafana:3000
}
CADDY
fi

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
# Observability stack config (Loki + Promtail + Prometheus + Grafana)
# Written inline (same pattern as listen.xml / init.sql above). The compose file
# bind-mounts each of these into its container.
# ----------------------------------------------------------------------------
mkdir -p /opt/apilens/loki /opt/apilens/promtail /opt/apilens/prometheus \
         /opt/apilens/grafana/provisioning/datasources

# Loki — single-binary, filesystem-backed store on the persistent disk. No auth
# (it's only reachable on the internal compose network). Retention handled by the
# compactor; ~14 days.
cat > /opt/apilens/loki/loki-config.yaml <<'YAML'
auth_enabled: false

server:
  http_listen_port: 3100
  grpc_listen_port: 9096
  log_level: warn

common:
  instance_addr: 127.0.0.1
  path_prefix: /loki
  storage:
    filesystem:
      chunks_directory: /loki/chunks
      rules_directory: /loki/rules
  replication_factor: 1
  ring:
    kvstore:
      store: inmemory

schema_config:
  configs:
    - from: 2024-01-01
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h

limits_config:
  retention_period: 336h
  reject_old_samples: true
  reject_old_samples_max_age: 168h
  ingestion_rate_mb: 16
  ingestion_burst_size_mb: 32

compactor:
  working_directory: /loki/compactor
  retention_enabled: true
  delete_request_store: filesystem

analytics:
  reporting_enabled: false
YAML

# Promtail — discover containers via the docker socket and ship their json-file
# logs to Loki, labelled by container name + compose service.
cat > /opt/apilens/promtail/promtail-config.yaml <<'YAML'
server:
  http_listen_port: 9080
  grpc_listen_port: 0
  log_level: warn

positions:
  filename: /tmp/promtail/positions.yaml

clients:
  - url: http://loki:3100/loki/api/v1/push

scrape_configs:
  - job_name: docker
    docker_sd_configs:
      - host: unix:///var/run/docker.sock
        refresh_interval: 15s
    relabel_configs:
      # Strip the leading "/" docker puts on container names.
      - source_labels: ['__meta_docker_container_name']
        regex: '/(.*)'
        target_label: container_name
      - source_labels: ['__meta_docker_container_label_com_docker_compose_service']
        target_label: compose_service
      - source_labels: ['__meta_docker_container_log_stream']
        target_label: stream
YAML

# Prometheus — scrape the two exporters plus itself.
cat > /opt/apilens/prometheus/prometheus.yml <<'YAML'
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: prometheus
    static_configs:
      - targets: ['localhost:9090']
  - job_name: cadvisor
    static_configs:
      - targets: ['cadvisor:8080']
  - job_name: node-exporter
    static_configs:
      - targets: ['node-exporter:9100']
YAML

# Grafana — provision the Loki + Prometheus datasources so the UI works on first
# login with zero clicks. Prometheus is the default datasource.
cat > /opt/apilens/grafana/provisioning/datasources/datasources.yaml <<'YAML'
apiVersion: 1

datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
    editable: false
  - name: Loki
    type: loki
    access: proxy
    url: http://loki:3100
    editable: false
YAML

# ----------------------------------------------------------------------------
# .env (locked down)
# ----------------------------------------------------------------------------
(
  umask 077
  cat > /opt/apilens/.env <<ENV
REGISTRY_BASE=${REGISTRY_BASE}
IMAGE_TAG=${IMAGE_TAG}
APP_SITE=${APP_SITE}
API_SITE=${API_SITE}
DJANGO_ALLOWED_HOSTS=${ALLOWED_HOSTS},api,web,localhost,127.0.0.1
CSRF_TRUSTED_ORIGINS=${CSRF_ORIGINS}
CORS_ALLOWED_ORIGINS=${CORS_ORIGINS}
FRONTEND_URL=${FRONTEND_URL}
MEDIA_BUCKET=${MEDIA_BUCKET}
GS_PROJECT_ID=${PROJECT_ID}
DJANGO_SECRET_KEY=${DJANGO_SECRET_KEY}
SESSION_SECRET=${SESSION_SECRET}
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
CLICKHOUSE_PASSWORD=${CLICKHOUSE_PASSWORD}
EMAIL_HOST_PASSWORD=${RESEND_API_KEY}
DEFAULT_FROM_EMAIL=${FROM_EMAIL}
WEBAUTHN_RP_ID=${WEBAUTHN_RP_ID}
WEBAUTHN_RP_NAME=${WEBAUTHN_RP_NAME}
GRAFANA_ADMIN_PASSWORD=${GRAFANA_ADMIN_PASSWORD}
GRAFANA_ROOT_URL=${GRAFANA_ROOT_URL}
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
