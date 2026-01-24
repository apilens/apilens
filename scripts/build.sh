#!/bin/bash
# =============================================================================
# ObserveX Production Build Script
# =============================================================================
# Builds frontend and collects Django static files

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}Building ObserveX for Production${NC}"
echo "================================"

# =============================================================================
# Build Frontend
# =============================================================================
echo -e "\n${YELLOW}Building frontend...${NC}"

if [ -d "static" ] && [ -f "static/package.json" ]; then
    cd static

    # Install dependencies if needed
    if [ ! -d "node_modules" ]; then
        echo "Installing frontend dependencies..."
        npm ci
    fi

    # Build
    npm run build

    cd ..
    echo -e "${GREEN}✓ Frontend built to static/dist/${NC}"
else
    echo -e "${YELLOW}⚠ Frontend not configured, skipping...${NC}"
fi

# =============================================================================
# Collect Django Static Files
# =============================================================================
echo -e "\n${YELLOW}Collecting Django static files...${NC}"

if [ -d ".venv" ]; then
    source .venv/bin/activate
fi

cd src
python manage.py collectstatic --noinput --settings=config.settings.production
cd ..

echo -e "${GREEN}✓ Static files collected to staticfiles/${NC}"

# =============================================================================
# Summary
# =============================================================================
echo ""
echo "================================"
echo -e "${GREEN}Build Complete!${NC}"
echo "================================"
echo ""
echo "Output locations:"
echo "  Frontend:     static/dist/"
echo "  Django static: staticfiles/"
