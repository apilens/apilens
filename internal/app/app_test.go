package app

import (
	"bytes"
	"io"
	"log/slog"
	"slices"
	"strings"
	"testing"

	"github.com/apilens/apilens/internal/platform/config"
)

func newTestApp() *App {
	return New(&config.Config{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func TestTargets(t *testing.T) {
	got := newTestApp().Targets()
	want := []string{TargetAll, TargetAPI, TargetEdge, TargetIdentity, TargetQuery}
	if !slices.Equal(got, want) {
		t.Fatalf("Targets() = %v, want %v", got, want)
	}
	for _, target := range got {
		if _, planned := PlannedTargets[target]; planned {
			t.Errorf("%q is both implemented and planned", target)
		}
	}
}

func TestResolve(t *testing.T) {
	a := newTestApp()
	for _, tc := range []struct {
		target string
		want   []string
	}{
		{TargetAll, []string{TargetEdge, TargetQuery, TargetAPI, TargetIdentity}},
		{TargetIdentity, []string{modServer, modPostgres, modValkey, modJobs, TargetIdentity}},
		{TargetAPI, []string{modServer, modPostgres, modValkey, TargetAPI}},
	} {
		order, err := a.mgr.Resolve([]string{tc.target})
		if err != nil {
			t.Fatalf("Resolve(%s): %v", tc.target, err)
		}
		for _, name := range tc.want {
			if !slices.Contains(order, name) {
				t.Errorf("Resolve(%s) = %v, missing %q", tc.target, order, name)
			}
		}
		// The listener must start after every route-registering module.
		http := slices.Index(order, modHTTP)
		if http < 0 {
			t.Fatalf("Resolve(%s) = %v, missing %q", tc.target, order, modHTTP)
		}
		for _, name := range []string{TargetAPI, TargetIdentity} {
			if i := slices.Index(order, name); i > http {
				t.Errorf("Resolve(%s) = %v: %q starts after %q", tc.target, order, name, modHTTP)
			}
		}
	}
}

// TestIdentityRoutesOnlyOnIdentityTargets pins where identity's routes (the
// auth API and GET /.well-known/jwks.json) are served: the identity module
// runs on the identity and all targets and on no other role.
func TestIdentityRoutesOnlyOnIdentityTargets(t *testing.T) {
	a := newTestApp()
	for _, tc := range []struct {
		target string
		want   bool
	}{
		{TargetAll, true},
		{TargetIdentity, true},
		{TargetAPI, false},
		{TargetQuery, false},
		{TargetEdge, false},
	} {
		order, err := a.mgr.Resolve([]string{tc.target})
		if err != nil {
			t.Fatalf("Resolve(%s): %v", tc.target, err)
		}
		if got := slices.Contains(order, TargetIdentity); got != tc.want {
			t.Errorf("Resolve(%s) includes identity = %t, want %t", tc.target, got, tc.want)
		}
	}
}

func TestWarnEmail(t *testing.T) {
	for _, tc := range []struct {
		name     string
		provider string
		target   []string
		want     bool
	}{
		{"log all", config.EmailProviderLog, []string{TargetAll}, true},
		{"log identity", config.EmailProviderLog, []string{TargetIdentity}, true},
		{"log api", config.EmailProviderLog, []string{TargetAPI}, true},
		{"log edge only", config.EmailProviderLog, []string{TargetEdge}, false},
		{"smtp all", config.EmailProviderSMTP, []string{TargetAll}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var buf bytes.Buffer
			cfg := &config.Config{Target: tc.target, Email: config.EmailConfig{Provider: tc.provider}}
			a := New(cfg, slog.New(slog.NewTextHandler(&buf, nil)))
			a.warnEmail()
			got := strings.Contains(buf.String(), "level=WARN") && strings.Contains(buf.String(), "email provider is log")
			if got != tc.want {
				t.Fatalf("warned = %v, want %v (log: %q)", got, tc.want, buf.String())
			}
		})
	}
}
