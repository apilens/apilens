#!/bin/bash
# =============================================================================
# ObserveX Dependency Installation Script
# =============================================================================
# Usage: ./scripts/install-deps.sh [dev|prod|test]

set -e

ENV=${1:-dev}

echo "Installing dependencies for environment: $ENV"

case $ENV in
    dev)
        echo "Installing development dependencies..."
        uv sync --extra dev
        ;;
    prod)
        echo "Installing production dependencies..."
        uv sync --no-dev --extra prod
        ;;
    test)
        echo "Installing test dependencies..."
        uv sync --extra test
        ;;
    *)
        echo "Unknown environment: $ENV"
        echo "Usage: $0 [dev|prod|test]"
        exit 1
        ;;
esac

echo "✓ Dependencies installed successfully for: $ENV"
