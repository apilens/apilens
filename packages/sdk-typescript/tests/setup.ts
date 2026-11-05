// Heartbeats and the metadata report are background POSTs that would show up
// in every test's fetch mock. Off by default here; tests/heartbeat.test.ts and
// tests/metadata.test.ts turn them back on.
process.env.APILENS_SEND_HEARTBEAT = "false";
process.env.APILENS_SEND_METADATA = "false";
// Tracing adds /v1/traces and /v1/logs POSTs; tests/tracing.test.ts turns it back on.
process.env.APILENS_CAPTURE_SPANS = "false";
