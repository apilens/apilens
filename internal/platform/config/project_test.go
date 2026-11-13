package config

import (
	"strings"
	"testing"
	"time"
)

func TestProjectDeletionGrace(t *testing.T) {
	cfg, err := Load("", []string{kekEnv}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Project.DeletionGrace != 7*24*time.Hour {
		t.Fatalf("default project.deletion_grace = %s, want 168h", cfg.Project.DeletionGrace)
	}
	for _, tt := range []struct {
		env  string
		want time.Duration
	}{{"APILENS_PROJECT__DELETION_GRACE=0s", 0}, {"APILENS_PROJECT__DELETION_GRACE=48h", 48 * time.Hour}} {
		cfg, err := Load("", []string{kekEnv, tt.env}, nil)
		if err != nil {
			t.Fatalf("%s: %v", tt.env, err)
		}
		if cfg.Project.DeletionGrace != tt.want {
			t.Errorf("%s: project.deletion_grace = %s, want %s", tt.env, cfg.Project.DeletionGrace, tt.want)
		}
	}
	_, err = Load("", []string{kekEnv, "APILENS_PROJECT__DELETION_GRACE=-1h"}, nil)
	if err == nil || !strings.Contains(err.Error(), "project.deletion_grace") {
		t.Fatalf("negative grace: err = %v", err)
	}
}
