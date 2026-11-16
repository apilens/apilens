package config

import (
	"strings"
	"testing"
)

func TestAuditRetention(t *testing.T) {
	cfg, err := Load("", []string{kekEnv}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Audit.Retention != 400 {
		t.Fatalf("default audit.retention = %d, want 400", cfg.Audit.Retention)
	}
	for _, tt := range []struct {
		env  string
		want int
	}{{"APILENS_AUDIT__RETENTION=0", 0}, {"APILENS_AUDIT__RETENTION=30", 30}, {"APILENS_AUDIT__RETENTION=730", 730}} {
		cfg, err := Load("", []string{kekEnv, tt.env}, nil)
		if err != nil {
			t.Fatalf("%s: %v", tt.env, err)
		}
		if cfg.Audit.Retention != tt.want {
			t.Errorf("%s: audit.retention = %d, want %d", tt.env, cfg.Audit.Retention, tt.want)
		}
	}
}

func TestAuditRetentionValidation(t *testing.T) {
	for _, env := range []string{"APILENS_AUDIT__RETENTION=29", "APILENS_AUDIT__RETENTION=-1", "APILENS_AUDIT__RETENTION=1"} {
		_, err := Load("", []string{kekEnv, env}, nil)
		if err == nil || !strings.Contains(err.Error(), "want 0 (keep forever) or at least 30 days") {
			t.Errorf("%s: err = %v", env, err)
		}
	}
}
