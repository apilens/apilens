"""Test-session defaults."""

import os

# Middlewares built by the test suite would otherwise register an atexit flush
# for their (fake or real) clients and try to deliver leftovers to the default
# ingest URL when pytest exits. Tests that exercise the hooks unset this.
os.environ.setdefault("APILENS_FLUSH_ON_SHUTDOWN", "false")
