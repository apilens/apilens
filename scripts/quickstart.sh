#!/bin/bash
# =============================================================================
# apilens Quickstart Script
# =============================================================================
# Quick deployment using Docker only - no local dependencies required

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}"
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║              apilens Quickstart                              ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# -----------------------------------------------------------------------------
# Check Prerequisites
# -----------------------------------------------------------------------------
echo -e "${YELLOW}Checking prerequisites...${NC}"

# Check Docker
if ! command -v docker &> /dev/null; then
    echo -e "${RED}Error: Docker is not installed${NC}"
    echo "Please install Docker: https://docs.docker.com/get-docker/"
    exit 1
fi
echo -e "${GREEN}✓ Docker found${NC}"

# Check Docker Compose
if docker compose version &> /dev/null; then
    DOCKER_COMPOSE="docker compose"
elif command -v docker-compose &> /dev/null; then
    DOCKER_COMPOSE="docker-compose"
else
    echo -e "${RED}Error: Docker Compose is not installed${NC}"
    exit 1
fi
echo -e "${GREEN}✓ Docker Compose found${NC}"

# -----------------------------------------------------------------------------
# Setup Environment
# -----------------------------------------------------------------------------
echo -e "\n${YELLOW}Setting up environment...${NC}"

# Create .env if it doesn't exist
if [ ! -f .env ]; then
    echo "Creating .env from .env.example..."
    cp .env.example .env

    # Generate random secrets
    DJANGO_SECRET=$(openssl rand -base64 50 | tr -dc 'a-zA-Z0-9' | head -c 50)
    POSTGRES_PASSWORD=$(openssl rand -base64 20 | tr -dc 'a-zA-Z0-9' | head -c 20)

    # Update secrets in .env
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s|DJANGO_SECRET_KEY=.*|DJANGO_SECRET_KEY=${DJANGO_SECRET}|" .env
        sed -i '' "s|POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${POSTGRES_PASSWORD}|" .env
    else
        sed -i "s|DJANGO_SECRET_KEY=.*|DJANGO_SECRET_KEY=${DJANGO_SECRET}|" .env
        sed -i "s|POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${POSTGRES_PASSWORD}|" .env
    fi

    echo -e "${GREEN}✓ Created .env with generated secrets${NC}"
else
    echo -e "${GREEN}✓ .env already exists${NC}"
fi

# -----------------------------------------------------------------------------
# Start Services
# -----------------------------------------------------------------------------
echo -e "\n${YELLOW}Starting apilens services...${NC}"

$DOCKER_COMPOSE -f docker-compose.prod.yml up -d --build

echo "Waiting for services to be healthy..."
sleep 30

# Check services
echo -e "\n${YELLOW}Checking service status...${NC}"
$DOCKER_COMPOSE -f docker-compose.prod.yml ps

# -----------------------------------------------------------------------------
# Run Migrations
# -----------------------------------------------------------------------------
echo -e "\n${YELLOW}Running database migrations...${NC}"

# Django migrations
$DOCKER_COMPOSE -f docker-compose.prod.yml exec -T backend python src/manage.py migrate --noinput

# ClickHouse migrations
$DOCKER_COMPOSE -f docker-compose.prod.yml exec -T backend python src/manage.py clickhouse_migrate || true

echo -e "${GREEN}✓ Migrations complete${NC}"

# -----------------------------------------------------------------------------
# Create Admin User
# -----------------------------------------------------------------------------
echo -e "\n${YELLOW}Creating default admin user...${NC}"

$DOCKER_COMPOSE -f docker-compose.prod.yml exec -T backend python src/manage.py shell << 'EOF'
from django.contrib.auth import get_user_model
User = get_user_model()
if not User.objects.filter(email='admin@apilens.local').exists():
    User.objects.create_superuser(
        username='admin',
        email='admin@apilens.local',
        password='admin'
    )
    print('Admin user created')
else:
    print('Admin user already exists')
EOF

echo -e "${GREEN}✓ Admin user ready${NC}"

# -----------------------------------------------------------------------------
# Done!
# -----------------------------------------------------------------------------
echo -e "\n${GREEN}"
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║              apilens is Running! 🚀                          ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

echo -e "${BLUE}Access URLs:${NC}"
echo "  Application:  http://localhost"
echo "  API:          http://localhost/api/v1/"
echo "  Admin Panel:  http://localhost/admin/"
echo ""
echo -e "${BLUE}Default Admin Credentials:${NC}"
echo "  Email:    admin@apilens.local"
echo "  Password: admin"
echo ""
echo -e "${RED}⚠ IMPORTANT: Change the admin password immediately!${NC}"
echo ""
echo -e "${BLUE}Useful commands:${NC}"
echo "  View logs:     $DOCKER_COMPOSE -f docker-compose.prod.yml logs -f"
echo "  Stop services: $DOCKER_COMPOSE -f docker-compose.prod.yml down"
echo "  Restart:       $DOCKER_COMPOSE -f docker-compose.prod.yml restart"
