// Heartbeats and the metadata report are background POSTs that would show up
// in every test's fetch mock. Off by default here; tests/heartbeat.test.ts and
// tests/metadata.test.ts turn them back on.
process.env.APILENS_SEND_HEARTBEAT = "false";
process.env.APILENS_SEND_METADATA = "false";
