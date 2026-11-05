"""Test-session defaults."""

import os

# Middlewares built by the test suite would otherwise register an atexit flush
# for their (fake or real) clients and try to deliver leftovers to the default
# ingest URL when pytest exits. Tests that exercise the hooks unset this.
os.environ.setdefault("APILENS_FLUSH_ON_SHUTDOWN", "false")

# Likewise every middleware would start an app metadata report (POST
# /v1/metadata) to the default ingest URL. test_metadata.py re-enables it.
os.environ.setdefault("APILENS_SEND_METADATA", "false")
