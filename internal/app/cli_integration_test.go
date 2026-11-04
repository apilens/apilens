//go:build integration

package app

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/apilens/apilens/internal/testutil"
)

func TestIdentityRotateKey(t *testing.T) {
	env := []string{
		"APILENS_POSTGRES__URL=" + testutil.Postgres(t).URL,
		"APILENS_IDENTITY__KEY_ENCRYPTION_KEY=ZGV2LW9ubHktaWRlbnRpdHkta2VrLTAxMjM0NTY3ODk=",
		"APILENS_LOG__FORMAT=text",
	}
	var stderr bytes.Buffer
	if code := Main([]string{"migrate", "-only=postgres"}, &bytes.Buffer{}, &stderr, env); code != 0 {
		t.Fatalf("migrate: exit %d: %s", code, stderr.String())
	}

	type result struct {
		KID        string `json:"kid"`
		RetiredKID string `json:"retired_kid"`
	}
	rotate := func() result {
		t.Helper()
		var stdout, stderr bytes.Buffer
		if code := Main([]string{"identity", "rotate-key"}, &stdout, &stderr, env); code != 0 {
			t.Fatalf("rotate-key: exit %d: %s", code, stderr.String())
		}
		var r result
		if err := json.Unmarshal(stdout.Bytes(), &r); err != nil {
			t.Fatalf("rotate-key output %q: %v", stdout.String(), err)
		}
		return r
	}

	// On an empty table there is nothing to retire.
	first := rotate()
	if first.KID == "" || first.RetiredKID != "" {
		t.Fatalf("first rotation = %+v", first)
	}
	second := rotate()
	if second.KID == "" || second.KID == first.KID || second.RetiredKID != first.KID {
		t.Fatalf("second rotation = %+v, want retired %s", second, first.KID)
	}
}
