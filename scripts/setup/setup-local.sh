#!/usr/bin/env bash
# Interactive local-dev bootstrap for APILens.
# Run: pnpm bootstrap  (or: bash scripts/setup/setup-local.sh)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

# ── Constants ────────────────────────────────────────────────────────────────
TOTAL_STEPS=5
SCRIPT_START=$(date +%s)
CURRENT_STEP=0
STEP_START_TIME=0

# Indentation hierarchy
I_STEP="   "          # 3 — step row (◆ title)
I_CONTENT="      "    # 6 — action icons + description
I_OUTPUT="         "  # 9 — streamed command output

# ── Colors (strict semantics) ────────────────────────────────────────────────
# CY brand/commands · GR success · YL warning · RD error · D secondary · B bold
R='\033[0m'; B='\033[1m'; D='\033[2m'
CY='\033[96m'; GR='\033[92m'; YL='\033[93m'; RD='\033[91m'; WH='\033[97m'

# ── Trap: always restore cursor; friendly Ctrl-C ─────────────────────────────
_cleanup() { tput cnorm 2>/dev/null || true; }
_on_interrupt() {
  _cleanup
  printf "\n\n  ${YL}↯  Interrupted.${R}  Resume any time with ${CY}${B}pnpm bootstrap${R}\n\n"
  exit 130
}
trap _cleanup EXIT
trap _on_interrupt INT

# ── UI primitives ────────────────────────────────────────────────────────────
ok()    { printf "%s${GR}✓${R}  %s\n" "$I_CONTENT" "$*"; }
warn()  { printf "%s${YL}⚠${R}  %s\n" "$I_CONTENT" "$*"; }
err()   { printf "%s${RD}✗${R}  %s\n" "$I_CONTENT" "$*" >&2; }
note()  { printf "%s${D}%s${R}\n"     "$I_CONTENT" "$*"; }

ask() {
  local default="${2:-y}"
  local hint; [[ "$default" == "y" ]] && hint="${B}Y${R}/n" || hint="y/${B}N${R}"
  printf "%s${B}${WH}?${R}  %s [%b] " "$I_CONTENT" "$1" "$hint"
  local ans; read -r ans </dev/tty
  ans="${ans:-$default}"
  [[ "$ans" =~ ^[Yy] ]]
}

format_elapsed() {
  local s=$1
  (( s < 60 )) && printf "%ds" "$s" || printf "%dm %ds" $((s/60)) $((s%60))
}

# ── Section / step orchestration ─────────────────────────────────────────────
divider() { printf "  ${D}━━━ %s ${R}${D}─────────────────────────────────────${R}\n" "$1"; }

# step_start "Title" "One-line description"
step_start() {
  CURRENT_STEP=$((CURRENT_STEP+1))
  STEP_START_TIME=$(date +%s)
  printf "\n"
  printf "  ${D}━━━${R} ${B}Step %d of %d${R} ${D}─────────────────────────────────────${R}\n" \
    "$CURRENT_STEP" "$TOTAL_STEPS"
  printf "%s${CY}◆${R}  ${B}%s${R}\n" "$I_STEP" "$1"
  [[ -n "${2:-}" ]] && printf "%s${D}%s${R}\n" "$I_CONTENT" "$2"
  printf "\n"
}

# phase_start "Action title" "Description"  (for pre-flight, not numbered)
# Divider always says "Pre-flight" so the ◆ title can describe the action.
phase_start() {
  printf "\n"
  printf "  ${D}━━━${R} ${B}Pre-flight${R} ${D}─────────────────────────────────────${R}\n"
  printf "%s${CY}◆${R}  ${B}%s${R}\n" "$I_STEP" "$1"
  [[ -n "${2:-}" ]] && printf "%s${D}%s${R}\n" "$I_CONTENT" "$2"
  printf "\n"
}

step_done() {
  local t=$(( $(date +%s) - STEP_START_TIME ))
  printf "\n%s${GR}✓${R}  ${B}Done${R} ${D}· %s${R}\n" "$I_CONTENT" "$(format_elapsed "$t")"
}

# step_skip_reused "Reused existing X"  — neutral, user chose this
step_skip_reused() {
  local t=$(( $(date +%s) - STEP_START_TIME ))
  printf "%s${D}↷  %s · %s${R}\n" "$I_CONTENT" "$1" "$(format_elapsed "$t")"
}

# step_skip_blocked "reason" — yellow, forced by upstream failure
step_skip_blocked() {
  printf "%s${YL}⊘${R}  ${YL}Blocked${R} ${D}— %s${R}\n" "$I_CONTENT" "$1"
}

# step_advise "fix1" "fix2" …  — "What to do next" block under a failure
step_advise() {
  printf "\n%s${CY}→${R}  ${B}What to do next${R}\n" "$I_CONTENT"
  for line in "$@"; do
    printf "%s${D}•${R} %s\n" "$I_OUTPUT" "$line"
  done
}

# ── Execution helpers ────────────────────────────────────────────────────────
# run_live  — streams output indented at I_OUTPUT level
# run_spin  — spinner + elapsed counter for quick silent ops

run_live() {
  local msg="$1"; shift
  printf "%s${CY}→${R}  ${B}%s${R}\n" "$I_CONTENT" "$msg"
  local rc=0
  set +e
  "$@" 2>&1 | sed "s/^/${I_OUTPUT}/"
  rc=${PIPESTATUS[0]}
  set -e
  if [[ $rc -ne 0 ]]; then
    printf "%s${RD}✗${R}  ${YL}Failed${R} ${D}· exit %s${R}\n" "$I_CONTENT" "$rc"
  fi
  return $rc
}

run_spin() {
  local msg="$1"; shift
  local log; log="$(mktemp)"
  local start; start=$(date +%s)
  "$@" >"$log" 2>&1 &
  local pid=$!
  local sp=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏') i=0
  tput civis 2>/dev/null || true
  while kill -0 "$pid" 2>/dev/null; do
    local t=$(( $(date +%s) - start ))
    printf "\r%s${CY}%s${R}  ${B}%s${R}  ${D}[%ds]${R}%-15s" \
      "$I_CONTENT" "${sp[$i]}" "$msg" "$t" ""
    i=$(( (i+1) % 10 )); sleep 0.12
  done
  tput cnorm 2>/dev/null || true
  printf "\r%-90s\r" ""
  local rc=0; wait "$pid" || rc=$?
  if [[ $rc -eq 0 ]]; then
    local t=$(( $(date +%s) - start ))
    printf "%s${CY}→${R}  ${B}%s${R} ${D}· %ds${R}\n" "$I_CONTENT" "$msg" "$t"
  else
    printf "%s${RD}✗${R}  ${YL}%s failed${R} ${D}· exit %s${R}\n" "$I_CONTENT" "$msg" "$rc"
    tail -20 "$log" | sed "s/^/${I_OUTPUT}/" >&2
  fi
  rm -f "$log"
  return $rc
}

# ── Port utilities ───────────────────────────────────────────────────────────
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

# ── Failure tracking (for the done screen) ───────────────────────────────────
STEP_JS_OK=false
STEP_VENV_OK=false
STEP_DB_OK=false
STEP_MIGRATE_OK=false

# step_name | reason | fix  (pipe-delimited; appended to FAILURES)
FAILURES=()
record_failure() { FAILURES+=("$1|$2|$3"); }

# ── Auto-installers ──────────────────────────────────────────────────────────
_install_pnpm() {
  warn "pnpm not found — attempting auto-install"
  if command -v npm >/dev/null 2>&1; then
    run_live "Installing pnpm@9 via npm" npm install -g pnpm@9 && ok "pnpm installed" && return 0
  fi
  if command -v corepack >/dev/null 2>&1; then
    run_live "Activating pnpm via corepack" bash -c 'corepack enable && corepack prepare pnpm@9 --activate' \
      && ok "pnpm activated" && return 0
  fi
  err "Cannot auto-install pnpm — npm not found"
  step_advise "Install Node.js v20+ first: https://nodejs.org" \
              "Then re-run: pnpm bootstrap"
  return 1
}

_install_uv() {
  warn "uv not found — attempting auto-install"
  if ! run_live "Downloading and installing uv" bash -c 'curl -LsSf https://astral.sh/uv/install.sh | sh'; then
    step_advise "Install uv manually: curl -LsSf https://astral.sh/uv/install.sh | sh" \
                "Then re-run: pnpm bootstrap"
    return 1
  fi
  export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
  if command -v uv >/dev/null 2>&1; then
    ok "uv installed"; return 0
  fi
  err "uv installed but not yet in PATH"
  step_advise "Restart your terminal" "Then re-run: pnpm bootstrap"
  return 1
}

# ── Secret generators ────────────────────────────────────────────────────────
gen_hex()        { openssl rand -hex 32; }
gen_django_key() { openssl rand -hex 25; }

# ── Banner ───────────────────────────────────────────────────────────────────
banner() {
  [[ -t 1 ]] && clear || printf '\n'
  printf "${CY}${B}\n"
  printf "    █████╗ ██████╗ ██╗██╗     ███████╗███╗   ██╗███████╗\n"
  printf "   ██╔══██╗██╔══██╗██║██║     ██╔════╝████╗  ██║██╔════╝\n"
  printf "   ███████║██████╔╝██║██║     █████╗  ██╔██╗ ██║███████╗\n"
  printf "   ██╔══██║██╔═══╝ ██║██║     ██╔══╝  ██║╚██╗██║╚════██║\n"
  printf "   ██║  ██║██║     ██║███████╗███████╗██║ ╚████║███████║\n"
  printf "   ╚═╝  ╚═╝╚═╝     ╚═╝╚══════╝╚══════╝╚═╝  ╚═══╝╚══════╝\n"
  printf "${R}\n"
  printf "   ${B}API Observability Platform${R} ${D}· Local Development Setup${R}\n\n"
  printf "   ${D}We'll do 5 things — pre-flight check, JS deps, Python venv,${R}\n"
  printf "   ${D}.env files, databases, and migrations. Takes 2–5 minutes.${R}\n"
  printf "   ${D}─────────────────────────────────────────────────────────${R}\n\n"
}

# ── Pre-flight ───────────────────────────────────────────────────────────────
preflight() {
  phase_start "Verifying required tools" "Auto-installs pnpm and uv if missing. node and python must be present."

  local has_node=false has_pnpm=false has_python=false has_uv=false has_docker=false

  _chk() {
    local name="$1" cmd="$2"
    if command -v "$cmd" >/dev/null 2>&1; then
      local ver; ver="$("$cmd" --version 2>&1 | head -1)" || ver="installed"
      printf "%s${GR}✓${R}  %-10s  ${D}%.55s${R}\n" "$I_CONTENT" "$name" "$ver"
      return 0
    fi
    printf "%s${RD}✗${R}  %-10s  ${YL}not found${R}\n" "$I_CONTENT" "$name"
    return 1
  }

  _chk node   node    && has_node=true   || true
  _chk pnpm   pnpm    && has_pnpm=true   || true
  _chk python python3 && has_python=true || true
  _chk uv     uv      && has_uv=true     || true
  _chk docker docker  && has_docker=true || true

  # node — cannot auto-install, hard exit
  if [[ "$has_node" == false ]]; then
    printf "\n"
    err "Node.js v20+ is required and cannot be auto-installed"
    step_advise "macOS:  brew install node" \
                "Other:  https://nodejs.org" \
                "Then re-run: pnpm bootstrap"
    exit 1
  fi

  # pnpm — auto-install
  if [[ "$has_pnpm" == false ]]; then
    printf "\n"
    _install_pnpm || exit 1
  fi

  # python — cannot auto-install, hard exit
  if [[ "$has_python" == false ]]; then
    printf "\n"
    err "Python 3.13 is required and cannot be auto-installed"
    step_advise "macOS:  brew install python@3.13" \
                "Other:  https://python.org" \
                "Then re-run: pnpm bootstrap"
    exit 1
  fi

  # uv — auto-install
  if [[ "$has_uv" == false ]]; then
    printf "\n"
    _install_uv || exit 1
  fi

  # docker — warn only
  if [[ "$has_docker" == false ]]; then
    printf "\n"
    warn "Docker not found — database step will be skipped"
    note "Install Docker Desktop: https://docs.docker.com/get-docker"
  fi

  printf "\n%s${GR}✓${R}  ${B}Environment ready${R}\n" "$I_CONTENT"
}

# ── Step 1: JS/TS dependencies ───────────────────────────────────────────────
step_js_deps() {
  step_start "JS/TS dependencies" "Installs all Node packages across the monorepo."

  if [[ -d node_modules ]]; then
    if ! ask "node_modules already exists — reinstall?" "n"; then
      step_skip_reused "Reused existing node_modules"
      STEP_JS_OK=true; return
    fi
  fi

  if run_live "Running pnpm install" pnpm install; then
    step_done
    STEP_JS_OK=true
  else
    step_advise "Check your network connection" \
                "Try clearing: rm -rf node_modules && pnpm store prune" \
                "Then re-run: pnpm bootstrap"
    record_failure "Step 1 · JS/TS dependencies" \
                   "pnpm install failed" \
                   "rm -rf node_modules && pnpm bootstrap"
  fi
}

# ── Step 2: Python venv ──────────────────────────────────────────────────────
step_python_venv() {
  step_start "Python venv" "Creates apps/api/.venv and installs Django + dependencies via uv."

  if [[ -d apps/api/.venv ]]; then
    if ! ask ".venv already exists — recreate?" "n"; then
      step_skip_reused "Reused existing .venv"
      STEP_VENV_OK=true; return
    fi
    note "Removing existing .venv…"
    rm -rf apps/api/.venv
  fi

  local rc=0
  (
    cd apps/api
    run_spin "Creating .venv" uv venv .venv                   || exit 1
    run_live "Installing Python packages" uv pip install -e . || exit 1
  ) || rc=$?

  if [[ $rc -ne 0 ]]; then
    step_advise "Verify Python 3.13: python3 --version" \
                "Manually: cd apps/api && uv venv .venv && uv pip install -e ." \
                "Then re-run: pnpm bootstrap"
    record_failure "Step 2 · Python venv" \
                   "uv venv or pip install failed" \
                   "fix Python install, then re-run pnpm bootstrap"
    return
  fi

  step_done
  STEP_VENV_OK=true
}

# ── Step 3: .env files ───────────────────────────────────────────────────────
step_env() {
  step_start "Environment files" "Copies .env.example → .env for both apps with real secrets baked in."

  _setup_env "apps/api/.env" \
             "apps/api/.env.example" \
             "DJANGO_SECRET_KEY" \
             "$(gen_django_key)" \
             "Django secret key"

  _setup_env "apps/web/.env" \
             "apps/web/.env.example" \
             "SESSION_SECRET" \
             "\"$(gen_hex)\"" \
             "Session encryption key"

  step_done
}

_setup_env() {
  local target="$1" example="$2" key="$3" value="$4" label="$5"

  if [[ ! -f "$example" ]]; then
    warn "$example not found — skipping"
    return
  fi

  if [[ -f "$target" ]]; then
    if ! ask "$target already exists — regenerate?" "n"; then
      printf "%s${D}↷  Kept existing %s${R}\n" "$I_CONTENT" "$target"
      return
    fi
  fi

  cp "$example" "$target"
  sed -i.bak "s|${key}=.*|${key}=${value}|" "$target"
  rm -f "${target}.bak"
  printf "%s${GR}✓${R}  ${B}%s${R} ${D}· %s auto-generated${R}\n" \
    "$I_CONTENT" "$target" "$label"
}

# ── Step 4: Databases ────────────────────────────────────────────────────────
DB_PG=5432
DB_CH_HTTP=8123
DB_CH_TCP=9000
DB_REDIS=6379

step_databases() {
  step_start "Local databases" "Starts postgres, clickhouse, and redis via docker compose."

  if ! command -v docker >/dev/null 2>&1; then
    step_skip_blocked "Docker not found"
    step_advise "Install Docker Desktop: https://docs.docker.com/get-docker" \
                "Then re-run: pnpm bootstrap"
    record_failure "Step 4 · Local databases" \
                   "Docker not installed" \
                   "install Docker Desktop, then re-run pnpm bootstrap"
    return
  fi
  if ! docker info >/dev/null 2>&1; then
    step_skip_blocked "Docker daemon is not running"
    step_advise "Start Docker Desktop" \
                "Then re-run: pnpm bootstrap"
    record_failure "Step 4 · Local databases" \
                   "Docker daemon not running" \
                   "start Docker Desktop, then re-run pnpm bootstrap"
    return
  fi

  local running
  running=$(docker compose -f infra/docker/docker-compose.local.yml ps -q 2>/dev/null | wc -l | tr -d ' ')

  if [[ "$running" -gt 0 ]]; then
    printf "%s${GR}✓${R}  Containers already running ${D}· skipping port scan${R}\n" "$I_CONTENT"
    if ask "Restart containers?" "n"; then
      if run_live "Restarting containers" \
          docker compose -f infra/docker/docker-compose.local.yml up -d; then
        ok "Databases restarted"
      else
        record_failure "Step 4 · Local databases" \
                       "docker compose restart failed" \
                       "run: docker compose -f infra/docker/docker-compose.local.yml up -d"
        return
      fi
    else
      printf "%s${D}↷  Kept current containers${R}\n" "$I_CONTENT"
    fi
    STEP_DB_OK=true
    _print_db_ports
    step_done
    return
  fi

  # ── Port scan ────────────────────────────────────────────────────────────
  printf "%s${B}Scanning ports…${R}\n\n" "$I_CONTENT"
  local remapped=false

  _scan_port() {
    local lbl="$1" port="$2" ref="$3"
    if port_in_use "$port"; then
      local owner; owner="$(who_owns "$port")"
      local new; new="$(find_free "$((port+1))")"
      printf "%s${YL}⚠${R}  :%-5d  %-20s  ${D}in use by %s${R}\n" "$I_CONTENT" "$port" "$lbl" "$owner"
      if ask "  Remap $lbl → :$new?" "y"; then
        eval "$ref=$new"; remapped=true
        printf "%s${GR}↪${R}  :%-5d  %-20s  ${D}remapped from :%d${R}\n" "$I_CONTENT" "$new" "$lbl" "$port"
      fi
    else
      printf "%s${GR}✓${R}  :%-5d  %-20s  ${D}free${R}\n" "$I_CONTENT" "$port" "$lbl"
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
      note "apps/api/.env updated with remapped ports"
    fi
  fi

  if run_live "Starting postgres + clickhouse + redis" "${compose_cmd[@]}" up -d; then
    STEP_DB_OK=true
    _print_db_ports
    step_done
  else
    step_advise "Check Docker Desktop is healthy" \
                "Check ports aren't held by other processes" \
                "Then re-run: pnpm bootstrap"
    record_failure "Step 4 · Local databases" \
                   "docker compose up failed" \
                   "fix docker, then re-run pnpm bootstrap"
  fi
}

_print_db_ports() {
  printf "%s${D}postgres   → localhost:%d${R}\n"               "$I_CONTENT" "$DB_PG"
  printf "%s${D}clickhouse → localhost:%d (HTTP) / %d (TCP)${R}\n" "$I_CONTENT" "$DB_CH_HTTP" "$DB_CH_TCP"
  printf "%s${D}redis      → localhost:%d${R}\n"               "$I_CONTENT" "$DB_REDIS"
}

# ── Step 5: Django migrations ────────────────────────────────────────────────
step_migrate() {
  step_start "Django migrations" "Creates database tables for users, sessions, projects, etc."

  if [[ "$STEP_VENV_OK" == false ]]; then
    step_skip_blocked "Step 2 (Python venv) did not complete"
    note "Migrations need the venv. Fix Step 2 then re-run."
    record_failure "Step 5 · Django migrations" \
                   "blocked by Step 2" \
                   "fix Step 2, then re-run pnpm bootstrap"
    return
  fi
  if [[ "$STEP_DB_OK" == false ]]; then
    step_skip_blocked "Step 4 (Databases) did not come up"
    note "Migrations need postgres. Fix Step 4 then re-run."
    record_failure "Step 5 · Django migrations" \
                   "blocked by Step 4" \
                   "fix Step 4, then re-run pnpm bootstrap"
    return
  fi

  if ! ask "Run Django migrations now?" "y"; then
    step_skip_reused "Skipped — run later: cd apps/api && .venv/bin/python manage.py migrate"
    STEP_MIGRATE_OK=true; return
  fi

  # Wait for postgres to actually accept connections
  printf "%s${CY}→${R}  ${B}Waiting for postgres${R}\n" "$I_CONTENT"
  local ready=false
  for _ in $(seq 1 20); do
    if docker exec apilens-local-postgres-1 pg_isready -U apilens -d apilens -q 2>/dev/null; then
      ready=true; break
    fi
    sleep 1
  done
  if [[ "$ready" == false ]]; then
    err "Postgres did not become ready within 20s"
    step_advise "Check docker compose logs: pnpm db:logs" \
                "Then run: cd apps/api && .venv/bin/python manage.py migrate"
    record_failure "Step 5 · Django migrations" \
                   "postgres unhealthy after 20s" \
                   "check pnpm db:logs, then run manage.py migrate manually"
    return
  fi
  printf "%s${GR}✓${R}  postgres is ready\n" "$I_CONTENT"

  local rc=0
  (
    cd apps/api
    run_live "Applying migrations" .venv/bin/python manage.py migrate --noinput || exit 1
  ) || rc=$?

  if [[ $rc -ne 0 ]]; then
    step_advise "Check APILENS_POSTGRES_URL in apps/api/.env:" \
                "    postgresql://apilens:apilens_dev@localhost:${DB_PG}/apilens" \
                "Then re-run: cd apps/api && .venv/bin/python manage.py migrate"
    record_failure "Step 5 · Django migrations" \
                   "migrate command failed" \
                   "check apps/api/.env DATABASE_URL, then re-run migrate"
    return
  fi

  step_done
  STEP_MIGRATE_OK=true
}

# ── Done screen ──────────────────────────────────────────────────────────────
done_screen() {
  local total_elapsed=$(( $(date +%s) - SCRIPT_START ))
  local total_str; total_str="$(format_elapsed "$total_elapsed")"

  printf "\n"

  if [[ "${#FAILURES[@]}" -eq 0 ]]; then
    _success_header "$total_str"
  else
    _failure_header "$total_str"
    _failure_breakdown
  fi

  _dev_port_warnings
  _next_steps
  _footer
}

_success_header() {
  local total="$1"
  printf "  ${GR}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${R}\n\n"
  printf "  ${GR}${B}  ✓  Setup complete${R}  ${D}· all %d steps finished in %s${R}\n\n" \
    "$TOTAL_STEPS" "$total"
  printf "  ${GR}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${R}\n"
}

_failure_header() {
  local total="$1"
  local ok_count=$((TOTAL_STEPS - ${#FAILURES[@]}))
  printf "  ${YL}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${R}\n\n"
  printf "  ${YL}${B}  ⚠  Setup incomplete${R}  ${D}· %d of %d steps finished in %s${R}\n\n" \
    "$ok_count" "$TOTAL_STEPS" "$total"
  printf "  ${YL}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${R}\n"
}

_failure_breakdown() {
  printf "\n  ${CY}◆${R}  ${B}What failed${R}\n\n"
  for entry in "${FAILURES[@]}"; do
    IFS='|' read -r name reason fix <<< "$entry"
    printf "%s${B}%s${R}\n"             "$I_CONTENT" "$name"
    printf "%s${D}Reason:${R}  %s\n"    "$I_OUTPUT" "$reason"
    printf "%s${D}Fix:${R}     %s\n\n"  "$I_OUTPUT" "$fix"
  done
  printf "  ${CY}◆${R}  ${B}Re-run${R}\n\n"
  printf "%s${CY}${B}pnpm bootstrap${R}    ${D}retries all steps (skips ones already done)${R}\n" \
    "$I_CONTENT"
}

_dev_port_warnings() {
  local django_alt="" web_alt=""

  if port_in_use 8000; then
    local owner; owner="$(who_owns 8000)"
    local alt;   alt="$(find_free 8001)"
    django_alt=":8000 is in use by ${owner} — start Django on :${alt}: cd apps/api && .venv/bin/python manage.py runserver ${alt}"
  fi
  if port_in_use 3002; then
    local owner; owner="$(who_owns 3002)"
    local alt;   alt="$(find_free 3003)"
    web_alt=":3002 is in use by ${owner} — change dev port in apps/web/package.json to ${alt}"
  fi

  if [[ -n "$django_alt" || -n "$web_alt" ]]; then
    printf "\n  ${CY}◆${R}  ${B}Heads up${R}\n\n"
    [[ -n "$django_alt" ]] && printf "%s${YL}⚠${R}  %s\n" "$I_CONTENT" "$django_alt"
    [[ -n "$web_alt"    ]] && printf "%s${YL}⚠${R}  %s\n" "$I_CONTENT" "$web_alt"
  fi
}

_next_steps() {
  printf "\n  ${CY}◆${R}  ${B}Start developing${R}\n\n"
  printf "%s${CY}${B}pnpm dev${R}                ${D}Next.js (:3002) + Django (:8000) via turbo${R}\n" "$I_CONTENT"

  printf "\n  ${CY}◆${R}  ${B}Handy commands${R}\n\n"
  printf "%s${CY}pnpm db:down${R}            ${D}Stop databases${R}\n" "$I_CONTENT"
  printf "%s${CY}pnpm db:logs${R}            ${D}Tail database logs${R}\n" "$I_CONTENT"
  printf "%s${CY}pnpm db:up${R}              ${D}Start databases again${R}\n" "$I_CONTENT"
}

_footer() {
  printf "\n  ${CY}◆${R}  ${B}Where to get help${R}\n\n"
  printf "%s${D}GitHub${R}         https://github.com/apilens/apilens\n" "$I_CONTENT"
  printf "%s${D}Docs${R}           apps/docs/\n"                          "$I_CONTENT"
  printf "\n  ${D}Magic-link emails print in the Django pane in turbo.${R}\n"
  printf "  ${D}Copy the link from there to sign in.${R}\n\n"
}

# ── Main ─────────────────────────────────────────────────────────────────────
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
