#!/bin/bash
# Run the APILens MCP server locally using the apps/api virtualenv (it
# bootstraps Django from apps/api, so it shares that env + settings).
set -e
cd "$(dirname "$0")/../api"
exec .venv/bin/python ../mcp/server.py
