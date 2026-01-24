#!/bin/bash
# =============================================================================
# ObserveX Combined Test Runner
# =============================================================================
# Runs both backend and frontend tests

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

BACKEND_RESULT=0
FRONTEND_RESULT=0

echo -e "${YELLOW}Running ObserveX Tests${NC}"
echo "================================"

# =============================================================================
# Backend Tests
# =============================================================================
echo -e "\n${YELLOW}Running Backend Tests...${NC}"

if [ -d ".venv" ]; then
    source .venv/bin/activate
fi

cd src
if pytest -v --tb=short; then
    echo -e "${GREEN}✓ Backend tests passed${NC}"
else
    BACKEND_RESULT=1
    echo -e "${RED}✗ Backend tests failed${NC}"
fi
cd ..

# =============================================================================
# Frontend Tests
# =============================================================================
echo -e "\n${YELLOW}Running Frontend Tests...${NC}"

if [ -d "static" ] && [ -f "static/package.json" ]; then
    cd static
    if npm test -- --passWithNoTests; then
        echo -e "${GREEN}✓ Frontend tests passed${NC}"
    else
        FRONTEND_RESULT=1
        echo -e "${RED}✗ Frontend tests failed${NC}"
    fi
    cd ..
else
    echo -e "${YELLOW}⚠ Frontend not configured, skipping...${NC}"
fi

# =============================================================================
# Summary
# =============================================================================
echo ""
echo "================================"
echo "Test Results:"
echo "================================"

if [ $BACKEND_RESULT -eq 0 ]; then
    echo -e "Backend:  ${GREEN}PASSED${NC}"
else
    echo -e "Backend:  ${RED}FAILED${NC}"
fi

if [ $FRONTEND_RESULT -eq 0 ]; then
    echo -e "Frontend: ${GREEN}PASSED${NC}"
else
    echo -e "Frontend: ${RED}FAILED${NC}"
fi

# Exit with error if any tests failed
if [ $BACKEND_RESULT -ne 0 ] || [ $FRONTEND_RESULT -ne 0 ]; then
    exit 1
fi

echo -e "\n${GREEN}All tests passed!${NC}"
