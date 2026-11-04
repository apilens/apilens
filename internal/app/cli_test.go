package app

import (
	"bytes"
	"strings"
	"testing"
)

func TestMigrateRejectsUnknownStep(t *testing.T) {
	var stderr bytes.Buffer
	// A valid base64 32-byte key so config validation passes.
	env := []string{"APILENS_IDENTITY__KEY_ENCRYPTION_KEY=ZGV2LW9ubHktaWRlbnRpdHkta2VrLTAxMjM0NTY3ODk="}
	if code := Main([]string{"migrate", "-only=postgres,bogus"}, &bytes.Buffer{}, &stderr, env); code != 1 {
		t.Fatalf("exit code = %d, want 1", code)
	}
	if !strings.Contains(stderr.String(), `unknown -only step "bogus"`) {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

func TestIdentityRejectsUnknownCommand(t *testing.T) {
	var stderr bytes.Buffer
	if code := Main([]string{"identity", "bogus"}, &bytes.Buffer{}, &stderr, nil); code != 1 {
		t.Fatalf("exit code = %d, want 1", code)
	}
	if !strings.Contains(stderr.String(), `identity: unknown command "bogus"`) {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

func TestUserRejectsUnknownCommand(t *testing.T) {
	var stderr bytes.Buffer
	if code := Main([]string{"user", "bogus"}, &bytes.Buffer{}, &stderr, nil); code != 1 {
		t.Fatalf("exit code = %d, want 1", code)
	}
	if !strings.Contains(stderr.String(), `user: unknown command "bogus"`) {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

func TestUserCommandsNeedFlags(t *testing.T) {
	env := []string{"APILENS_IDENTITY__KEY_ENCRYPTION_KEY=ZGV2LW9ubHktaWRlbnRpdHkta2VrLTAxMjM0NTY3ODk="}
	for _, args := range [][]string{
		{"user", "create", "-org=acme"},
		{"user", "promote", "-email=a@example.com"},
		{"user", "magic-link"},
	} {
		var stderr bytes.Buffer
		if code := Main(args, &bytes.Buffer{}, &stderr, env); code != 1 {
			t.Fatalf("%v: exit code = %d, want 1", args, code)
		}
		if !strings.Contains(stderr.String(), "required") {
			t.Fatalf("%v: stderr = %q", args, stderr.String())
		}
	}
}

func TestAuthzRejectsUnknownCommand(t *testing.T) {
	var stderr bytes.Buffer
	if code := Main([]string{"authz", "bogus"}, &bytes.Buffer{}, &stderr, nil); code != 1 {
		t.Fatalf("exit code = %d, want 1", code)
	}
	if !strings.Contains(stderr.String(), `authz: unknown command "bogus"`) {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

func TestAuthzReconcileNeedsEndpoint(t *testing.T) {
	var stderr bytes.Buffer
	env := []string{"APILENS_IDENTITY__KEY_ENCRYPTION_KEY=ZGV2LW9ubHktaWRlbnRpdHkta2VrLTAxMjM0NTY3ODk="}
	if code := Main([]string{"authz", "reconcile"}, &bytes.Buffer{}, &stderr, env); code != 1 {
		t.Fatalf("exit code = %d, want 1", code)
	}
	if !strings.Contains(stderr.String(), "authz.endpoint is not set") {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

func TestMigrateAuthzSkippedWithoutEndpoint(t *testing.T) {
	var stderr bytes.Buffer
	env := []string{"APILENS_IDENTITY__KEY_ENCRYPTION_KEY=ZGV2LW9ubHktaWRlbnRpdHkta2VrLTAxMjM0NTY3ODk=", "APILENS_LOG__FORMAT=text"}
	if code := Main([]string{"migrate", "-only=authz"}, &bytes.Buffer{}, &stderr, env); code != 0 {
		t.Fatalf("exit code = %d, stderr = %s", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "skipping the SpiceDB schema") {
		t.Fatalf("stderr = %q", stderr.String())
	}
}
