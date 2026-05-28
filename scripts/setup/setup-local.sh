#!/usr/bin/env bash
# Interactive local-dev bootstrap for APILens.
# Run: pnpm bootstrap  (or: bash scripts/setup/setup-local.sh)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

TOTAL_STEPS=5

# ── Colors ────────────────────────────────────────────────────────────────────
R='\033[0m'; B='\033[1m'; D='\033[2m'
CY='\033[96m'; GR='\033[92m'; YL='\033[93m'; RD='\033[91m'; WH='\033[97m'

# ── UI primitives ─────────────────────────────────────────────────────────────
ok()    { printf "  ${GR}✓${R}  %s\n"          "$*"; }
warn()  { printf "  ${YL}⚠${R}  %s\n"          "$*"; }
err()   { printf "  ${RD}✗${R}  %s\n"          "$*" >&2; }
info()  { printf "  ${D}   %s${R}\n"            "$*"; }
skip()  { printf "  ${D}↷  skipped — %s${R}\n" "$*"; }
label() { printf "  ${B}%s${R}\n"              "$*"; }

STEP=0
section() {
  STEP=$((STEP+1))
  printf "\n${CY}${B}  ── [%d/%d] %s${R}\n\n" "$STEP" "$TOTAL_STEPS" "$*"
}

ask() {
  local default="${2:-y}"
  local hint; [[ "$default" == "y" ]] && hint="${B}Y${R}/n" || hint="y/${B}N${R}"
  printf "  ${B}${WH}?${R}  %s [%b] " "$1" "$hint"
  local ans; read -r ans </dev/tty
  ans="${ans:-$default}"
  [[ "$ans" =~ ^[Yy] ]]
}

# ── Execution helpers ─────────────────────────────────────────────────────────
#
# run_live  — streams command output to terminal with indentation.
#             Use for long operations where the user wants to see what's
#             happening: pnpm install, uv pip install, docker compose, migrate.
#
# run_spin  — hides output and shows a spinner + elapsed-time counter.
#             Use for quick silent ops: uv venv creation, docker restart.

run_live() {
  # run_live "what we're doing" cmd [args...]
  local msg="$1"; shift
  printf "  ${D}→  %s${R}\n" "$msg"
  local rc=0
  # Temporarily suspend errexit so the pipe exit code is catchable.
  set +e
  "$@" 2>&1 | sed 's/^/    /'
  rc=${PIPESTATUS[0]}
  set -e
  if [[ $rc -ne 0 ]]; then
    err "Command failed (exit $rc)"
    return $rc
  fi
}

run_spin() {
  # run_spin "what we're doing" cmd [args...]
  local msg="$1"; shift
  local log; log="$(mktemp)"
  local start; start=$(date +%s)
  "$@" >"$log" 2>&1 &
  local pid=$!
  local sp=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏') i=0
  tput civis 2>/dev/null || true
  while kill -0 "$pid" 2>/dev/null; do
    local t=$(( $(date +%s) - start ))
    printf "\r  ${CY}%s${R}  ${B}%s${R}  ${D}[%ds elapsed]${R}%-10s" "${sp[$i]}" "$msg" "$t" ""
    i=$(( (i+1) % 10 )); sleep 0.12
  done
  tput cnorm 2>/dev/null || true
  printf "\r%-90s\r" ""
  local rc=0; wait "$pid" || rc=$?
  if [[ $rc -ne 0 ]]; then
    err "Command failed (exit $rc):"
    tail -30 "$log" | sed 's/^/    /' >&2
  fi
  rm -f "$log"
  return $rc
}

# ── Port utilities ────────────────────────────────────────────────────────────
port_in_use() { lsof -i ":$1" -sTCP:LISTEN -t >/dev/null 2>&1; }

who_owns() {
  local pid; pid=$(lsof -i ":$1" -sTCP:LISTEN -t 2>/dev/null | head -1)
  [[ -n "$pid" ]] || { printf "unknown process"; return; }
  local name; name=$(ps -p "$pid" -o comm= 2>/dev/null || printf "unknown")
  printf "%s (PID %s)" "$name" "$pid"
}

find_free() {
  local p=$1
  while port_in_use "$p"; do p=$((p+1)); done
  printf "%d" "$p"
}

# ── Step outcome tracking ─────────────────────────────────────────────────────
STEP_JS_OK=false
STEP_VENV_OK=false
STEP_DB_OK=false

# ── Auto-installers ───────────────────────────────────────────────────────────
_install_pnpm() {
  warn "pnpm not found — attempting auto-install…"
  if command -v npm >/dev/null 2>&1; then
    run_live "Installing pnpm@9 via npm" npm install -g pnpm@9 && ok "pnpm installed" && return 0
  fi
  if command -v corepack >/dev/null 2>&1; then
    run_live "Activating pnpm via corepack" bash -c 'corepack enable && corepack prepare pnpm@9 --activate' \
      && ok "pnpm activated" && return 0
  fi
  err "Cannot auto-install pnpm — npm not found."
  info "Install Node.js v20+ first: https://nodejs.org"
  return 1
}

_install_uv() {
  warn "uv not found — attempting auto-install…"
  run_live "Downloading and installing uv" bash -c 'curl -LsSf https://astral.sh/uv/install.sh | sh' || {
    err "uv installation failed."
    info "Install manually: curl -LsSf https://astral.sh/uv/install.sh | sh"
    return 1
  }
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
  if command -v uv >/dev/null 2>&1; then
    ok "uv installed"; return 0
  fi
  err "uv installed but not in PATH — restart your terminal, then re-run."
  return 1
}

# ── Secret generators ─────────────────────────────────────────────────────────
gen_hex()        { openssl rand -hex 32; }
gen_django_key() { openssl rand -hex 25; }

# ── Banner ────────────────────────────────────────────────────────────────────
banner() {
  [[ -t 1 ]] && clear || printf '\n'
  printf "${CY}${B}\n"
  printf "   ╭─────────────────────────────────────────────────╮\n"
  printf "   │                                                 │\n"
  printf "   │   ◆  APILens                                    │\n"
  printf "   │      API Observability Platform                 │\n"
  printf "   │      Local Development Setup                    │\n"
  printf "   │                                                 │\n"
  printf "   ╰─────────────────────────────────────────────────╯\n"
  printf "${R}\n"
  printf "   ${D}Track requests · See performance · Get alerts when things break${R}\n\n"
}

# ── Pre-flight ────────────────────────────────────────────────────────────────
preflight() {
  label "Pre-flight checks"
  printf "\n"

  local has_node=false has_pnpm=false has_python=false has_uv=false has_docker=false

  _chk() {
    local name="$1" cmd="$2"
    if command -v "$cmd" >/dev/null 2>&1; then
      local ver; ver="$("$cmd" --version 2>&1 | head -1)" || ver="installed"
      printf "  ${GR}✓${R}  %-10s  ${D}%.55s${R}\n" "$name" "$ver"
      return 0
    fi
    printf "  ${RD}✗${R}  %-10s  ${YL}not found${R}\n" "$name"
    return 1
  }

  _chk node   node    && has_node=true   || true
  _chk pnpm   pnpm    && has_pnpm=true   || true
  _chk python python3 && has_python=true || true
  _chk uv     uv      && has_uv=true     || true
  _chk docker docker  && has_docker=true || true
  printf "\n"

  # node: hard stop — cannot auto-install
  if [[ "$has_node" == false ]]; then
    err "Node.js v20+ is required and cannot be auto-installed."
    info "macOS:  brew install node"
    info "Other:  https://nodejs.org"
    exit 1
  fi

  # pnpm: auto-install via npm or corepack
  if [[ "$has_pnpm" == false ]]; then
    _install_pnpm || exit 1
    printf "\n"
  fi

  # python: hard stop — cannot auto-install
  if [[ "$has_python" == false ]]; then
    err "Python 3.13 is required and cannot be auto-installed."
    info "macOS:  brew install python@3.13"
    info "Other:  https://python.org"
    exit 1
  fi

  # uv: auto-install via official curl installer
  if [[ "$has_uv" == false ]]; then
    _install_uv || exit 1
    printf "\n"
  fi

  # docker: warn only — only needed for step 4
  if [[ "$has_docker" == false ]]; then
    warn "Docker not found — database step will be skipped."
    info "Install Docker Desktop: https://docs.docker.com/get-docker"
    printf "\n"
  fi
}

# ── Step 1: JS/TS deps ────────────────────────────────────────────────────────
step_js_deps() {
  section "JS/TS dependencies  (pnpm install)"

  if [[ -d node_modules ]]; then
    if ! ask "node_modules already exists — reinstall?" "n"; then
      skip "pnpm install"
      STEP_JS_OK=true; return
    fi
  fi

  if run_live "Running pnpm install" pnpm install; then
    ok "pnpm install done"
    STEP_JS_OK=true
  else
    err "pnpm install failed — fix the errors above, then re-run pnpm bootstrap"
  fi
}

# ── Step 2: Python venv ───────────────────────────────────────────────────────
step_python_venv() {
  section "Python venv  (apps/api)"

  if [[ -d apps/api/.venv ]]; then
    if ! ask ".venv already exists — recreate?" "n"; then
      skip "venv setup"
      STEP_VENV_OK=true; return
    fi
    info "Removing existing .venv…"
    rm -rf apps/api/.venv
  fi

  local rc=0
  (
    cd apps/api
    run_spin "Creating .venv" uv venv .venv                 || exit 1
    run_live "Installing Python packages" uv pip install -e . || exit 1
  ) || rc=$?

  if [[ $rc -ne 0 ]]; then
    err "Python venv setup failed — Django migrations will be skipped."
    return
  fi

  ok "venv ready at apps/api/.venv"
  STEP_VENV_OK=true
}

# ── Step 3: .env files ────────────────────────────────────────────────────────
step_env() {
  section "Environment files  (.env)"
  _setup_api_env
  _setup_web_env
}

_setup_api_env() {
  if [[ ! -f apps/api/.env.example ]]; then
    warn "apps/api/.env.example not found — skipping"; return
  fi
  if [[ -f apps/api/.env ]]; then
    if ! ask "apps/api/.env already exists — regenerate?" "n"; then
      skip "apps/api/.env"; return
    fi
  fi
  cp apps/api/.env.example apps/api/.env
  local key; key="$(gen_django_key)"
  sed -i.bak "s|DJANGO_SECRET_KEY=.*|DJANGO_SECRET_KEY=${key}|" apps/api/.env
  rm -f apps/api/.env.bak
  ok "apps/api/.env created"
  info "DJANGO_SECRET_KEY auto-generated ✓"
}

_setup_web_env() {
  if [[ ! -f apps/web/.env.example ]]; then
    warn "apps/web/.env.example not found — skipping"; return
  fi
  if [[ -f apps/web/.env ]]; then
    if ! ask "apps/web/.env already exists — regenerate?" "n"; then
      skip "apps/web/.env"; return
    fi
  fi
  cp apps/web/.env.example apps/web/.env
  local secret; secret="$(gen_hex)"
  sed -i.bak "s|SESSION_SECRET=.*|SESSION_SECRET=\"${secret}\"|" apps/web/.env
  rm -f apps/web/.env.bak
  ok "apps/web/.env created"
  info "SESSION_SECRET auto-generated ✓"
}

# ── Step 4: Databases ─────────────────────────────────────────────────────────
DB_PG=5432
DB_CH_HTTP=8123
DB_CH_TCP=9000
DB_REDIS=6379

step_databases() {
  section "Local databases  (docker compose)"

  if ! command -v docker >/dev/null 2>&1; then
    warn "Docker not found — skipping database setup."
    info "Install Docker Desktop: https://docs.docker.com/get-docker"
    return
  fi
  if ! docker info >/dev/null 2>&1; then
    warn "Docker daemon is not running."
    info "Start Docker Desktop, then re-run: pnpm bootstrap"
    return
  fi

  # Skip port scan if containers are already up
  local running
  running=$(docker compose -f infra/docker/docker-compose.local.yml ps -q 2>/dev/null | wc -l | tr -d ' ')

  if [[ "$running" -gt 0 ]]; then
    ok "Containers already running — skipping port scan"
    if ask "Restart containers?" "n"; then
      run_live "Restarting containers" \
        docker compose -f infra/docker/docker-compose.local.yml up -d \
        && ok "Databases restarted" || { err "Restart failed"; return; }
    else
      skip "docker compose up"
    fi
    STEP_DB_OK=true
    _print_db_ports; return
  fi

  # ── Port conflict scan ────────────────────────────────────────────────────
  label "Scanning ports…"
  printf "\n"
  local remapped=false

  _scan_port() {
    local lbl="$1" port="$2" ref="$3"
    if port_in_use "$port"; then
      local owner; owner="$(who_owns "$port")"
      local new; new="$(find_free "$((port+1))")"
      printf "  ${YL}⚠${R}  :%-5d  %-20s  ${D}in use by %s${R}\n" "$port" "$lbl" "$owner"
      if ask "    Remap $lbl → :$new?" "y"; then
        eval "$ref=$new"; remapped=true
        printf "  ${GR}↪${R}  :%-5d  %-20s  ${D}remapped from :%d${R}\n" "$new" "$lbl" "$port"
      fi
    else
      printf "  ${GR}✓${R}  :%-5d  %-20s  ${D}free${R}\n" "$port" "$lbl"
    fi
  }

  _scan_port "PostgreSQL"       "$DB_PG"      DB_PG
  _scan_port "ClickHouse HTTP"  "$DB_CH_HTTP" DB_CH_HTTP
  _scan_port "ClickHouse TCP"   "$DB_CH_TCP"  DB_CH_TCP
  _scan_port "Redis"            "$DB_REDIS"   DB_REDIS
  printf "\n"

  local compose_cmd=("docker" "compose" "-f" "infra/docker/docker-compose.local.yml")

  if [[ "$remapped" == true ]]; then
    local override="infra/docker/docker-compose.override.yml"
    cat > "$override" <<YML
# Auto-generated by pnpm bootstrap — local port remaps. Do not commit.
services:
  postgres:
    ports: ["${DB_PG}:5432"]
  clickhouse:
    ports: ["${DB_CH_HTTP}:8123", "${DB_CH_TCP}:9000"]
  redis:
    ports: ["${DB_REDIS}:6379"]
YML
    compose_cmd+=("-f" "$override")
    if [[ -f apps/api/.env ]]; then
      sed -i.bak  "s|\(postgresql://[^@]*@localhost:\)[0-9]*|\1${DB_PG}|g"     apps/api/.env
      sed -i.bak2 "s|\(clickhouse://[^@]*@localhost:\)[0-9]*|\1${DB_CH_TCP}|g" apps/api/.env
      rm -f apps/api/.env.bak apps/api/.env.bak2
      info "apps/api/.env updated with remapped ports"
    fi
  fi

  if run_live "Starting postgres + clickhouse + redis" "${compose_cmd[@]}" up -d; then
    ok "Databases up"
    STEP_DB_OK=true
  else
    err "docker compose failed — database step incomplete."
    return
  fi

  _print_db_ports
}

_print_db_ports() {
  info "postgres   → localhost:${DB_PG}"
  info "clickhouse → localhost:${DB_CH_HTTP} (HTTP) / ${DB_CH_TCP} (TCP)"
  info "redis      → localhost:${DB_REDIS}"
}

# ── Step 5: Django migrations ─────────────────────────────────────────────────
step_migrate() {
  section "Django migrations  (optional)"

  if [[ "$STEP_VENV_OK" == false ]]; then
    skip "Python venv did not complete — cannot run migrations"; return
  fi
  if [[ "$STEP_DB_OK" == false ]]; then
    skip "Database did not come up — cannot run migrations"; return
  fi
  if ! ask "Run Django migrations now?" "y"; then
    skip "run later:  cd apps/api && .venv/bin/python manage.py migrate"; return
  fi

  # Wait for postgres to accept connections (cold-start safety)
  info "Waiting for postgres…"
  local ready=false
  for _ in $(seq 1 20); do
    if docker exec apilens-local-postgres-1 pg_isready -U apilens -d apilens -q 2>/dev/null; then
      ready=true; break
    fi
    sleep 1
  done
  if [[ "$ready" == false ]]; then
    err "Postgres did not become ready within 20s."
    info "Run migrations manually: cd apps/api && .venv/bin/python manage.py migrate"
    return
  fi

  local rc=0
  (
    cd apps/api
    run_live "Applying migrations" .venv/bin/python manage.py migrate --noinput || exit 1
  ) || rc=$?

  if [[ $rc -ne 0 ]]; then
    err "Migrations failed."
    info "Check that APILENS_POSTGRES_URL in apps/api/.env matches:"
    info "  postgresql://apilens:apilens_dev@localhost:${DB_PG}/apilens"
    return
  fi

  ok "Migrations applied"
}

# ── Done screen ───────────────────────────────────────────────────────────────
done_screen() {
  local django_port=8000 web_port=3002
  local django_alt="" web_alt=""

  if port_in_use "$django_port"; then
    local owner; owner="$(who_owns "$django_port")"
    local alt;   alt="$(find_free "$((django_port+1))")"
    django_alt="$(printf "  ${YL}⚠${R}  :8000 in use by ${D}%s${R} — start Django on :${B}%d${R}:\n  ${D}    cd apps/api && .venv/bin/python manage.py runserver %d${R}" "$owner" "$alt" "$alt")"
  fi
  if port_in_use "$web_port"; then
    local owner; owner="$(who_owns "$web_port")"
    local alt;   alt="$(find_free "$((web_port+1))")"
    web_alt="$(printf "  ${YL}⚠${R}  :3002 in use by ${D}%s${R} — change dev port in apps/web/package.json to ${B}%d${R}" "$owner" "$alt")"
  fi

  printf "\n"

  local any_failed=false
  [[ "$STEP_JS_OK"   == false ]] && { warn "Step 1 (JS/TS deps) did not complete.";  any_failed=true; }
  [[ "$STEP_VENV_OK" == false ]] && { warn "Step 2 (Python venv) did not complete."; any_failed=true; }
  [[ "$STEP_DB_OK"   == false ]] && { warn "Step 4 (Databases) did not complete.";   any_failed=true; }

  if [[ "$any_failed" == true ]]; then
    printf "\n"
    warn "Fix the issues above then re-run:  ${CY}pnpm bootstrap${R}"
    printf "\n"
  else
    printf "${GR}${B}  ╭──────────────────────────────────────────────╮${R}\n"
    printf "${GR}${B}  │  ✓  Setup complete! You're ready to build.   │${R}\n"
    printf "${GR}${B}  ╰──────────────────────────────────────────────╯${R}\n"
    printf "\n"
  fi

  [[ -n "$django_alt" ]] && printf "%b\n\n" "$django_alt"
  [[ -n "$web_alt"    ]] && printf "%b\n\n" "$web_alt"

  label "Start developing"
  printf "\n"
  printf "  ${CY}pnpm dev${R}        ${D}# starts Next.js (:3002) + Django (:8000) via turbo${R}\n"
  printf "\n"
  label "Handy commands"
  printf "\n"
  printf "  ${CY}pnpm db:down${R}    ${D}# stop databases${R}\n"
  printf "  ${CY}pnpm db:logs${R}    ${D}# tail database logs${R}\n"
  printf "\n"
  printf "  ${D}Magic-link emails print in the Django pane. Copy the link to sign in.${R}\n\n"
}

# ── Main ──────────────────────────────────────────────────────────────────────
main() {
  banner
  preflight
  step_js_deps
  step_python_venv
  step_env
  step_databases
  step_migrate
  done_screen
}

main
