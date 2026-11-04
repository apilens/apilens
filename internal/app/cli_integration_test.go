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

func TestIdentityCreateClient(t *testing.T) {
	env := []string{
		"APILENS_POSTGRES__URL=" + testutil.Postgres(t).URL,
		"APILENS_IDENTITY__KEY_ENCRYPTION_KEY=ZGV2LW9ubHktaWRlbnRpdHkta2VrLTAxMjM0NTY3ODk=",
		"APILENS_LOG__FORMAT=text",
	}
	var stderr bytes.Buffer
	if code := Main([]string{"migrate", "-only=postgres"}, &bytes.Buffer{}, &stderr, env); code != 0 {
		t.Fatalf("migrate: exit %d: %s", code, stderr.String())
	}

	var stdout bytes.Buffer
	stderr.Reset()
	args := []string{"identity", "create-client", "-name=Agent", "-grant-types=client_credentials"}
	if code := Main(args, &stdout, &stderr, env); code != 0 {
		t.Fatalf("create-client: exit %d: %s", code, stderr.String())
	}
	var c struct {
		ClientID     string   `json:"client_id"`
		ClientSecret string   `json:"client_secret"`
		AuthMethod   string   `json:"token_endpoint_auth_method"`
		GrantTypes   []string `json:"grant_types"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &c); err != nil {
		t.Fatalf("create-client output %q: %v", stdout.String(), err)
	}
	if c.ClientID == "" || c.ClientSecret == "" || c.AuthMethod != "client_secret_basic" || len(c.GrantTypes) != 1 {
		t.Errorf("client = %+v", c)
	}

	// A public client cannot use client_credentials.
	stderr.Reset()
	args = []string{"identity", "create-client", "-public", "-grant-types=client_credentials"}
	if code := Main(args, &bytes.Buffer{}, &stderr, env); code == 0 {
		t.Error("a public client_credentials client was registered")
	}
}
