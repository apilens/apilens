package config

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestDefaultsAreValid(t *testing.T) {
	cfg, err := Load("", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(cfg.Target, []string{"all"}) {
		t.Fatalf("target = %v", cfg.Target)
	}
	if cfg.Sink.FlushInterval != 250*time.Millisecond {
		t.Fatalf("flush interval = %v", cfg.Sink.FlushInterval)
	}
	if cfg.Valkey.Enabled() {
		t.Fatal("valkey should be disabled by default")
	}
}

func TestPrecedenceFileEnvFlags(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	yaml := "server:\n  addr: \":9000\"\npostgres:\n  max_conns: 5\nlog:\n  level: debug\n"
	if err := os.WriteFile(path, []byte(yaml), 0o600); err != nil {
		t.Fatal(err)
	}
	env := []string{
		"APILENS_POSTGRES__MAX_CONNS=7",
		"APILENS_CLICKHOUSE__ADDR=ch1:9000, ch2:9000",
		"APILENS_VALKEY__ADDR=valkey:6379",
		"APILENS_SINK__FLUSH_INTERVAL=1s",
		"UNRELATED=1",
	}
	cfg, err := Load(path, env, map[string]any{"log.level": "warn"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Server.Addr != ":9000" {
		t.Errorf("file not applied: addr=%q", cfg.Server.Addr)
	}
	if cfg.Postgres.MaxConns != 7 {
		t.Errorf("env should beat file: max_conns=%d", cfg.Postgres.MaxConns)
	}
	if cfg.Log.Level != "warn" {
		t.Errorf("flags should beat everything: level=%q", cfg.Log.Level)
	}
	if !slices.Equal(cfg.ClickHouse.Addr, []string{"ch1:9000", "ch2:9000"}) {
		t.Errorf("list env not split: %v", cfg.ClickHouse.Addr)
	}
	if !cfg.Valkey.Enabled() {
		t.Error("valkey should be enabled")
	}
	if cfg.Sink.FlushInterval != time.Second {
		t.Errorf("duration not parsed: %v", cfg.Sink.FlushInterval)
	}
}

func TestValidationErrorsAreReported(t *testing.T) {
	env := []string{"APILENS_LOG__LEVEL=loud", "APILENS_SINK__MODE=kafka", "APILENS_SINK__ACK=never"}
	_, err := Load("", env, nil)
	if err == nil {
		t.Fatal("expected error")
	}
	for _, want := range []string{"log.level", "kafka is not available", "sink.ack"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q missing %q", err, want)
		}
	}
}

func TestMissingFile(t *testing.T) {
	if _, err := Load("/does/not/exist.yaml", nil, nil); err == nil {
		t.Fatal("expected error for missing file")
	}
}
