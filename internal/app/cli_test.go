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
