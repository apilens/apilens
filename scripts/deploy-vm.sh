#!/bin/bash
# =============================================================================
# ItsFriday Production VM Deployment Script
# =============================================================================
# Usage: ./deploy-vm.sh <DOMAIN> <EMAIL>
# Example: ./deploy-vm.sh itsfriday.example.com admin@example.com

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Arguments
DOMAIN=${1:-}
EMAIL=${2:-}

if [ -z "$DOMAIN" ] || [ -z "$EMAIL" ]; then
    echo -e "${RED}Usage: $0 <DOMAIN> <EMAIL>${NC}"
    echo "Example: $0 itsfriday.example.com admin@example.com"
    exit 1
fi

echo -e "${BLUE}"
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║         ItsFriday Production Deployment                        ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

echo -e "${YELLOW}Domain: ${DOMAIN}${NC}"
echo -e "${YELLOW}Email:  ${EMAIL}${NC}"
echo ""

# -----------------------------------------------------------------------------
# Update System
# -----------------------------------------------------------------------------
echo -e "${YELLOW}Updating system packages...${NC}"
apt-get update && apt-get upgrade -y

# -----------------------------------------------------------------------------
# Install Docker
# -----------------------------------------------------------------------------
echo -e "${YELLOW}Installing Docker...${NC}"

if ! command -v docker &> /dev/null; then
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker

    # Add current user to docker group
    usermod -aG docker $USER
fi

echo -e "${GREEN}✓ Docker installed${NC}"

# Install Docker Compose plugin
if ! docker compose version &> /dev/null; then
    apt-get install -y docker-compose-plugin
fi
echo -e "${GREEN}✓ Docker Compose installed${NC}"

# -----------------------------------------------------------------------------
# Setup Application Directory
# -----------------------------------------------------------------------------
echo -e "${YELLOW}Setting up application directory...${NC}"

APP_DIR="/opt/itsfriday"
mkdir -p $APP_DIR
cd $APP_DIR

# Clone or update repository
if [ -d ".git" ]; then
    echo "Updating existing installation..."
    git pull origin main
else
    echo "Cloning repository..."
    git clone https://github.com/itsfriday-in/itsfriday.git .
fi

# -----------------------------------------------------------------------------
# Configure Environment
# -----------------------------------------------------------------------------
echo -e "${YELLOW}Configuring environment...${NC}"

if [ ! -f .env ]; then
    cp .env.example .env
fi

# Generate secrets
DJANGO_SECRET=$(openssl rand -base64 50 | tr -dc 'a-zA-Z0-9' | head -c 50)
POSTGRES_PASSWORD=$(openssl rand -base64 20 | tr -dc 'a-zA-Z0-9' | head -c 20)

# Update .env with production settings
sed -i "s|DJANGO_SECRET_KEY=.*|DJANGO_SECRET_KEY=${DJANGO_SECRET}|" .env
sed -i "s|DJANGO_DEBUG=.*|DJANGO_DEBUG=False|" .env
sed -i "s|DJANGO_ALLOWED_HOSTS=.*|DJANGO_ALLOWED_HOSTS=${DOMAIN}|" .env
sed -i "s|POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${POSTGRES_PASSWORD}|" .env
sed -i "s|CORS_ALLOWED_ORIGINS=.*|CORS_ALLOWED_ORIGINS=https://${DOMAIN}|" .env

echo -e "${GREEN}✓ Environment configured${NC}"

# -----------------------------------------------------------------------------
# Setup SSL with Certbot
# -----------------------------------------------------------------------------
echo -e "${YELLOW}Setting up SSL certificate...${NC}"

# Install certbot
if ! command -v certbot &> /dev/null; then
    apt-get install -y certbot
fi

# Create certbot directories
mkdir -p certbot/conf certbot/www

# Get initial certificate (standalone mode)
certbot certonly --standalone \
    -d $DOMAIN \
    --email $EMAIL \
    --agree-tos \
    --non-interactive \
    --config-dir ./certbot/conf \
    --work-dir ./certbot/work \
    --logs-dir ./certbot/logs

# Update nginx config for SSL
cat > infrastructure/docker/nginx/nginx.conf << NGINX_EOF
upstream backend {
    server backend:8000;
}

# Redirect HTTP to HTTPS
server {
    listen 80;
    server_name ${DOMAIN};

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

# HTTPS server
server {
    listen 443 ssl http2;
    server_name ${DOMAIN};

    ssl_certificate /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256;
    ssl_prefer_server_ciphers off;

    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/plain text/css text/xml text/javascript application/javascript application/json;

    location / {
        root /usr/share/nginx/html;
        index index.html;
        try_files \$uri \$uri/ /index.html;
    }

    location /api/ {
        proxy_pass http://backend;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /admin/ {
        proxy_pass http://backend;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location /django-static/ {
        alias /app/staticfiles/;
        expires 1y;
    }
}
NGINX_EOF

echo -e "${GREEN}✓ SSL configured${NC}"

# -----------------------------------------------------------------------------
# Start Application
# -----------------------------------------------------------------------------
echo -e "${YELLOW}Starting ItsFriday...${NC}"

docker compose -f docker-compose.prod.yml up -d --build

echo "Waiting for services..."
sleep 30

# Run migrations
docker compose -f docker-compose.prod.yml exec -T backend python src/manage.py migrate --noinput
docker compose -f docker-compose.prod.yml exec -T backend python src/manage.py clickhouse_migrate || true

# Create admin user
docker compose -f docker-compose.prod.yml exec -T backend python src/manage.py shell << 'EOF'
from django.contrib.auth import get_user_model
User = get_user_model()
if not User.objects.filter(email='admin@itsfriday.local').exists():
    User.objects.create_superuser('admin', 'admin@itsfriday.local', 'admin')
EOF

echo -e "${GREEN}✓ Application started${NC}"

# -----------------------------------------------------------------------------
# Setup Systemd Service
# -----------------------------------------------------------------------------
echo -e "${YELLOW}Setting up systemd service...${NC}"

cp infrastructure/systemd/itsfriday.service /etc/systemd/system/
sed -i "s|/opt/itsfriday|${APP_DIR}|g" /etc/systemd/system/itsfriday.service

systemctl daemon-reload
systemctl enable itsfriday
systemctl start itsfriday

echo -e "${GREEN}✓ Systemd service configured${NC}"

# -----------------------------------------------------------------------------
# Setup Certificate Renewal
# -----------------------------------------------------------------------------
echo -e "${YELLOW}Setting up certificate auto-renewal...${NC}"

# Add cron job for certificate renewal
(crontab -l 2>/dev/null; echo "0 0 * * * certbot renew --config-dir ${APP_DIR}/certbot/conf --work-dir ${APP_DIR}/certbot/work --logs-dir ${APP_DIR}/certbot/logs --quiet && docker compose -f ${APP_DIR}/docker-compose.prod.yml exec -T nginx nginx -s reload") | crontab -

echo -e "${GREEN}✓ Auto-renewal configured${NC}"

# -----------------------------------------------------------------------------
# Done!
# -----------------------------------------------------------------------------
echo -e "\n${GREEN}"
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║         Deployment Complete! 🎉                               ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

echo -e "${BLUE}Your ItsFriday instance is running at:${NC}"
echo "  https://${DOMAIN}"
echo ""
echo -e "${BLUE}Admin panel:${NC}"
echo "  https://${DOMAIN}/admin/"
echo ""
echo -e "${BLUE}Default credentials:${NC}"
echo "  Email:    admin@itsfriday.local"
echo "  Password: admin"
echo ""
echo -e "${RED}⚠ IMPORTANT: Change the admin password immediately!${NC}"
echo ""
echo -e "${BLUE}Management commands:${NC}"
echo "  systemctl status itsfriday  - Check service status"
echo "  systemctl restart itsfriday - Restart application"
echo "  journalctl -u itsfriday -f  - View logs"
