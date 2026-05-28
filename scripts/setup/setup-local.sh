#!/usr/bin/env bash
# Interactive local-dev bootstrap for APILens.
# Run: pnpm bootstrap  (or: bash scripts/setup/setup-local.sh)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

# ── Colors ────────────────────────────────────────────────────────────────────
R='\033[0m'; B='\033[1m'; D='\033[2m'
CY='\033[96m'; GR='\033[92m'; YL='\033[93m'; RD='\033[91m'; WH='\033[97m'

# ── UI Primitives ─────────────────────────────────────────────────────────────
ok()    { printf "  ${GR}✓${R}  %s\n"          "$*"; }
warn()  { printf "  ${YL}⚠${R}  %s\n"          "$*"; }
err()   { printf "  ${RD}✗${R}  %s\n"          "$*" >&2; }
info()  { printf "  ${D}   %s${R}\n"            "$*"; }
skip()  { printf "  ${D}↷  skipped — %s${R}\n" "$*"; }
label() { printf "  ${B}%s${R}\n"              "$*"; }

STEP=0
section() {
  STEP=$((STEP+1))
  printf "\n${CY}${B}  ── Step %d ─ %s${R}\n\n" "$STEP" "$*"
}

ask() {
  # ask "prompt" [default=y]  →  0=yes  1=no
  local default="${2:-y}"
  local hint; [[ "$default" == "y" ]] && hint="${B}Y${R}/n" || hint="y/${B}N${R}"
  printf "  ${B}${WH}?${R}  %s [%b] " "$1" "$hint"
  local ans; read -r ans </dev/tty
  ans="${ans:-$default}"
  [[ "$ans" =~ ^[Yy] ]]
}

spin() {
  local pid=$1 msg="${2:-}" i=0
  local sp=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
  tput civis 2>/dev/null || true
  while kill -0 "$pid" 2>/dev/null; do
    printf "\r  ${CY}%s${R}  ${D}%s${R}" "${sp[$i]}" "$msg"
    i=$(( (i+1) % 10 )); sleep 0.08
  done
  tput cnorm 2>/dev/null || true
  printf "\r%-70s\r" ""
}

run_spin() {
  # run_spin "message" cmd [args...]
  local msg="$1"; shift
  local log; log="$(mktemp)"
  "$@" >"$log" 2>&1 &
  local pid=$!
  spin "$pid" "$msg"
  if ! wait "$pid"; then
    err "Command failed. Output:"; cat "$log" >&2; rm -f "$log"; exit 1
  fi
  rm -f "$log"
}

# ── Port utilities ────────────────────────────────────────────────────────────
port_in_use() {
  lsof -i ":$1" -sTCP:LISTEN -t >/dev/null 2>&1
}

who_owns() {
  local pid; pid=$(lsof -i ":$1" -sTCP:LISTEN -t 2>/dev/null | head -1)
  [[ -n "$pid" ]] || { printf "unknown process"; return; }
  local name; name=$(ps -p "$pid" -o comm= 2>/dev/null || printf "unknown")
  printf "%s (PID %s)" "$name" "$pid"
}

find_free() {
  # find_free BASE  →  first free port >= BASE
  local p=$1
  while port_in_use "$p"; do p=$((p+1)); done
  printf "%d" "$p"
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
  local all_ok=true

  check_tool() {
    local name="$1" cmd="$2" hint="$3"
    if command -v "$cmd" >/dev/null 2>&1; then
      local ver; ver="$("$cmd" --version 2>&1 | head -1)" || ver="installed"
      printf "  ${GR}✓${R}  %-12s ${D}%.55s${R}\n" "$name" "$ver"
    else
      printf "  ${RD}✗${R}  %-12s ${YL}not found${R} — %s\n" "$name" "$hint"
      all_ok=false
    fi
  }

  check_tool node   node    "https://nodejs.org  (v20+)"
  check_tool pnpm   pnpm    "corepack enable && corepack prepare pnpm@9 --activate"
  check_tool python python3 "https://python.org  (3.13)"
  check_tool uv     uv      "curl -LsSf https://astral.sh/uv/install.sh | sh"
  check_tool docker docker  "https://docs.docker.com/get-docker"
  printf "\n"

  if [[ "$all_ok" == false ]]; then
    warn "Some tools are missing. Install them and re-run setup."
    ask "Continue anyway?" "n" || exit 0
  fi
}

# ── Step 1: JS/TS deps ────────────────────────────────────────────────────────
step_js_deps() {
  section "JS/TS dependencies  (pnpm install)"

  if ! command -v pnpm >/dev/null 2>&1; then
    err "pnpm not found — skipping"; return
  fi

  if [[ -d node_modules ]]; then
    if ! ask "node_modules already exists — reinstall?" "n"; then
      skip "pnpm install"; return
    fi
  fi

  run_spin "Installing JS/TS packages…" pnpm install
  ok "pnpm install done"
}

# ── Step 2: Python venv ───────────────────────────────────────────────────────
step_python_venv() {
  section "Python venv  (apps/api)"

  if ! command -v uv >/dev/null 2>&1; then
    err "uv not found — skipping"; return
  fi

  if [[ -d apps/api/.venv ]]; then
    if ! ask ".venv already exists — recreate?" "n"; then
      skip "venv setup"; return
    fi
    info "Removing existing .venv…"
    rm -rf apps/api/.venv
  fi

  (
    cd apps/api
    run_spin "Creating .venv…"             uv venv .venv
    run_spin "Installing Python packages…" uv pip install --quiet -e .
  )
  ok "venv ready at apps/api/.venv"
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

# Ports used by this step — exported so done_screen can read them
DB_PG=5432
DB_CH_HTTP=8123
DB_CH_TCP=9000
DB_REDIS=6379

step_databases() {
  section "Local databases  (docker compose)"

  if ! command -v docker >/dev/null 2>&1; then
    warn "docker not found — skipping"; return
  fi
  if ! docker info >/dev/null 2>&1; then
    warn "Docker daemon is not running"
    info "Start Docker Desktop and re-run: pnpm setup"
    return
  fi

  # ── Are containers already running? ──────────────────────────────────────
  local running
  running=$(docker compose -f infra/docker/docker-compose.local.yml ps -q 2>/dev/null | wc -l | tr -d ' ')

  if [[ "$running" -gt 0 ]]; then
    ok "Containers already running — skipping port check"
    if ask "Restart containers?" "n"; then
      run_spin "Restarting…" docker compose -f infra/docker/docker-compose.local.yml up -d
      ok "Databases restarted"
    else
      skip "docker compose up"
    fi
    _print_db_ports
    return
  fi

  # ── Port conflict check ───────────────────────────────────────────────────
  label "Checking ports…"
  printf "\n"

  local remapped=false

  _check_port() {
    # _check_port "label" host_port varname
    local lbl="$1" port="$2" ref="$3"
    if port_in_use "$port"; then
      local owner; owner="$(who_owns "$port")"
      local new; new="$(find_free "$((port+1))")"
      printf "  ${YL}⚠${R}  :%-5d  %-20s ${D}in use by %s${R}\n" "$port" "$lbl" "$owner"
      if ask "    Remap $lbl to :$new?" "y"; then
        eval "$ref=$new"
        remapped=true
        printf "  ${GR}✓${R}  :%-5d  %-20s ${D}remapped from :%d${R}\n" "$new" "$lbl" "$port"
      else
        printf "  ${YL}!${R}  :%-5d  %-20s ${YL}kept — may fail to start${R}\n" "$port" "$lbl"
      fi
    else
      printf "  ${GR}✓${R}  :%-5d  %-20s ${D}free${R}\n" "$port" "$lbl"
    fi
  }

  _check_port "PostgreSQL"       "$DB_PG"      DB_PG
  _check_port "ClickHouse HTTP"  "$DB_CH_HTTP" DB_CH_HTTP
  _check_port "ClickHouse TCP"   "$DB_CH_TCP"  DB_CH_TCP
  _check_port "Redis"            "$DB_REDIS"   DB_REDIS
  printf "\n"

  # ── Build compose command (with override if needed) ───────────────────────
  local compose_cmd=("docker" "compose" "-f" "infra/docker/docker-compose.local.yml")

  if [[ "$remapped" == true ]]; then
    local override="infra/docker/docker-compose.override.yml"
    cat > "$override" <<YML
# Auto-generated by pnpm setup — local port remaps.
# Regenerate by running: pnpm setup
# This file is gitignored.
services:
  postgres:
    ports:
      - "${DB_PG}:5432"
  clickhouse:
    ports:
      - "${DB_CH_HTTP}:8123"
      - "${DB_CH_TCP}:9000"
  redis:
    ports:
      - "${DB_REDIS}:6379"
YML
    compose_cmd+=("-f" "$override")
    info "Port override saved → infra/docker/docker-compose.override.yml"

    # Patch .env files so DATABASE_URL etc. point at the new ports
    if [[ -f apps/api/.env ]]; then
      # Postgres: postgresql://...@localhost:OLD/db  →  @localhost:NEW/db
      sed -i.bak "s|\(postgresql://[^@]*@localhost:\)[0-9]*|\1${DB_PG}|g" apps/api/.env
      # ClickHouse: clickhouse://...@localhost:OLD/db  →  @localhost:NEW/db
      sed -i.bak2 "s|\(clickhouse://[^@]*@localhost:\)[0-9]*|\1${DB_CH_TCP}|g" apps/api/.env
      rm -f apps/api/.env.bak apps/api/.env.bak2
      ok "apps/api/.env updated with remapped ports"
    fi

    printf "\n"
    warn "Future db commands need the override file:"
    info "docker compose -f infra/docker/docker-compose.local.yml \\"
    info "               -f infra/docker/docker-compose.override.yml up -d"
    printf "\n"
  fi

  run_spin "Starting postgres + clickhouse + redis…" "${compose_cmd[@]}" up -d
  ok "Databases up"
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

  if [[ ! -d apps/api/.venv ]]; then
    skip "no .venv found"; return
  fi
  if ! ask "Run Django migrations now?" "y"; then
    skip "run later: cd apps/api && .venv/bin/python manage.py migrate"
    return
  fi
  (
    cd apps/api
    run_spin "Applying migrations…" .venv/bin/python manage.py migrate --noinput
  )
  ok "Migrations applied"
}

# ── Done screen ───────────────────────────────────────────────────────────────
done_screen() {
  # Check dev server ports and suggest alternatives if blocked
  local django_port=8000
  local web_port=3002
  local django_alt="" web_alt=""

  if port_in_use "$django_port"; then
    local owner; owner="$(who_owns "$django_port")"
    local alt; alt="$(find_free "$((django_port+1))")"
    django_alt="$(printf "  ${YL}⚠${R}  :8000 in use by ${D}%s${R} — start Django on :${B}%d${R} instead:\n  ${D}    .venv/bin/python manage.py runserver %d${R}" "$owner" "$alt" "$alt")"
  fi

  if port_in_use "$web_port"; then
    local owner; owner="$(who_owns "$web_port")"
    local alt; alt="$(find_free "$((web_port+1))")"
    web_alt="$(printf "  ${YL}⚠${R}  :3002 in use by ${D}%s${R} — edit apps/web/package.json dev port to ${B}%d${R}" "$owner" "$alt")"
  fi

  printf "\n"
  printf "${GR}${B}  ╭──────────────────────────────────────────────╮${R}\n"
  printf "${GR}${B}  │  ✓  Setup complete! You're ready to build.   │${R}\n"
  printf "${GR}${B}  ╰──────────────────────────────────────────────╯${R}\n"
  printf "\n"

  # Show port warnings if any
  if [[ -n "$django_alt" ]]; then
    printf "%b\n\n" "$django_alt"
  fi
  if [[ -n "$web_alt" ]]; then
    printf "%b\n\n" "$web_alt"
  fi

  label "Start developing"
  printf "\n"
  printf "  ${CY}pnpm dev${R}                        ${D}# frontend + backend together (turbo TUI)${R}\n"
  printf "                                  ${D}Next.js → http://localhost:3002${R}\n"
  printf "                                  ${D}Django  → http://localhost:8000${R}\n"
  printf "\n"
  label "Handy commands"
  printf "\n"
  printf "  ${CY}pnpm db:down${R}                    ${D}# stop databases${R}\n"
  printf "  ${CY}pnpm db:logs${R}                    ${D}# tail database logs${R}\n"
  printf "\n"
  printf "  ${D}Magic-link emails print to the Django pane in turbo. Copy the link to sign in.${R}\n\n"
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
