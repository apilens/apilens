package config

import (
	"strings"
	"testing"
)

func TestRetention(t *testing.T) {
	cfg, err := Load("", []string{kekEnv}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if r := cfg.Retention; r != (RetentionConfig{Requests: 90, Logs: 30, Spans: 30, Rollups1m: 30, Rollups1h: 400}) {
		t.Fatalf("default retention = %+v", r)
	}
	cfg, err = Load("", []string{kekEnv, "APILENS_RETENTION__LOGS=7", "APILENS_RETENTION__ROLLUPS_1H=730"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Retention.Logs != 7 || cfg.Retention.Rollups1h != 730 || cfg.Retention.Requests != 90 {
		t.Fatalf("retention = %+v", cfg.Retention)
	}
}

func TestRetentionValidation(t *testing.T) {
	for _, tt := range []struct{ env, wantErr string }{
		{"APILENS_RETENTION__REQUESTS=0", "retention.requests 0: want 1 to 3650 days"},
		{"APILENS_RETENTION__SPANS=4000", "retention.spans 4000: want 1 to 3650 days"},
		{"APILENS_RETENTION__ROLLUPS_1M=401", "retention.rollups_1m 401: want 1 to 400 days"},
		{"APILENS_RETENTION__ROLLUPS_1H=7", "retention.rollups_1h 7: want 30 to 3650 days"},
	} {
		_, err := Load("", []string{kekEnv, tt.env}, nil)
		if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
			t.Errorf("%s: err = %v, want %q", tt.env, err, tt.wantErr)
		}
	}
}
