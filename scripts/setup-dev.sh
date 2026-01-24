#!/bin/bash
# =============================================================================
# ItsFriday Development Setup Script
# =============================================================================
# This script sets up a local development environment

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}"
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║              ItsFriday Development Setup                       ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# -----------------------------------------------------------------------------
# Check Prerequisites
# -----------------------------------------------------------------------------
echo -e "${YELLOW}Checking prerequisites...${NC}"

# Check Python
if ! command -v python3 &> /dev/null; then
    echo -e "${RED}Error: Python 3 is not installed${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Python 3 found: $(python3 --version)${NC}"

# Check Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js is not installed${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Node.js found: $(node --version)${NC}"

# Check Docker
if ! command -v docker &> /dev/null; then
    echo -e "${RED}Error: Docker is not installed${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Docker found: $(docker --version)${NC}"

# Check Docker Compose
if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
    echo -e "${RED}Error: Docker Compose is not installed${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Docker Compose found${NC}"

# -----------------------------------------------------------------------------
# Install UV if not present
# -----------------------------------------------------------------------------
if ! command -v uv &> /dev/null; then
    echo -e "${YELLOW}Installing UV package manager...${NC}"
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.cargo/bin:$PATH"
fi
echo -e "${GREEN}✓ UV found: $(uv --version)${NC}"

# -----------------------------------------------------------------------------
# Setup Environment File
# -----------------------------------------------------------------------------
echo -e "\n${YELLOW}Setting up environment...${NC}"

if [ ! -f .env ]; then
    echo "Creating .env from .env.example..."
    cp .env.example .env

    # Generate a random secret key
    SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_urlsafe(50))")

    # Update the secret key in .env (macOS compatible)
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s|DJANGO_SECRET_KEY=.*|DJANGO_SECRET_KEY=${SECRET_KEY}|" .env
    else
        sed -i "s|DJANGO_SECRET_KEY=.*|DJANGO_SECRET_KEY=${SECRET_KEY}|" .env
    fi

    echo -e "${GREEN}✓ Created .env with generated secret key${NC}"
else
    echo -e "${GREEN}✓ .env already exists${NC}"
fi

# -----------------------------------------------------------------------------
# Setup Python Virtual Environment
# -----------------------------------------------------------------------------
echo -e "\n${YELLOW}Setting up Python environment...${NC}"

if [ ! -d .venv ]; then
    echo "Creating virtual environment..."
    uv venv
fi

echo "Installing Python dependencies..."
uv sync --extra dev

echo -e "${GREEN}✓ Python environment ready${NC}"

# -----------------------------------------------------------------------------
# Setup Frontend
# -----------------------------------------------------------------------------
echo -e "\n${YELLOW}Setting up frontend...${NC}"

if [ -d static ] && [ -f static/package.json ]; then
    cd static
    echo "Installing Node.js dependencies..."
    npm install
    cd ..
    echo -e "${GREEN}✓ Frontend dependencies installed${NC}"
else
    echo -e "${YELLOW}⚠ No frontend package.json found, skipping...${NC}"
fi

# -----------------------------------------------------------------------------
# Start Docker Services
# -----------------------------------------------------------------------------
echo -e "\n${YELLOW}Starting Docker services...${NC}"

docker-compose up -d

echo "Waiting for services to be ready..."
sleep 15

# Check service health
echo "Checking service health..."
docker-compose ps

echo -e "${GREEN}✓ Docker services started${NC}"

# -----------------------------------------------------------------------------
# Run Migrations
# -----------------------------------------------------------------------------
echo -e "\n${YELLOW}Running database migrations...${NC}"

# Activate venv and run migrations
source .venv/bin/activate

cd src
python manage.py migrate
cd ..

echo -e "${GREEN}✓ Django migrations complete${NC}"

# ClickHouse migrations (if available)
echo "Running ClickHouse migrations..."
cd src
python manage.py clickhouse_migrate --status || echo "ClickHouse migrations will be run when ClickHouse app is configured"
cd ..

# -----------------------------------------------------------------------------
# Create Superuser (optional)
# -----------------------------------------------------------------------------
echo -e "\n${YELLOW}Would you like to create a Django superuser? [y/N]${NC}"
read -r response
if [[ "$response" =~ ^([yY][eE][sS]|[yY])$ ]]; then
    cd src
    python manage.py createsuperuser
    cd ..
fi

# -----------------------------------------------------------------------------
# Done!
# -----------------------------------------------------------------------------
echo -e "\n${GREEN}"
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║              Setup Complete! 🎉                               ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

echo -e "${BLUE}Next steps:${NC}"
echo ""
echo "1. Activate the virtual environment:"
echo "   source .venv/bin/activate"
echo ""
echo "2. Start the Django development server:"
echo "   cd src && python manage.py runserver"
echo ""
echo "3. Start the frontend development server:"
echo "   cd static && npm run dev"
echo ""
echo -e "${BLUE}URLs:${NC}"
echo "  Backend API:  http://localhost:8000/api/v1/"
echo "  Django Admin: http://localhost:8000/admin/"
echo "  Frontend:     http://localhost:3000/"
echo ""
echo -e "${BLUE}Docker services:${NC}"
echo "  PostgreSQL:   localhost:5432"
echo "  ClickHouse:   localhost:9000 (native), localhost:8123 (HTTP)"
echo "  Redis:        localhost:6379"
