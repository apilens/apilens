package audit

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
)

func strArg(v any) string {
	p, _ := v.(*string)
	if p == nil {
		return "<nil>"
	}
	return *p
}

func TestRecordWritesScopeTargetChangesAndRequestID(t *testing.T) {
	conn := &fakeDB{}
	rec := New(conn)
	user, org, project := uuid.New(), uuid.New(), uuid.New()
	var reqID string
	h := Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reqID = RequestFrom(r.Context()).ID
		if err := rec.Record(r.Context(), Event{
			User: &user, Actor: &user, Kind: APIKeyUpdated, Org: &org, Project: &project,
			Target:  Target{Type: "api_key", ID: "k1", Label: "ci"},
			Changes: &Changes{Previous: map[string]any{"scopes": []string{"ingest"}}, Next: map[string]any{"scopes": []string{"ingest", "read"}}},
		}); err != nil {
			t.Fatal(err)
		}
	}))
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	req.Header.Set(RequestIDHeader, "client-chosen") // must be ignored
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if _, err := uuid.Parse(reqID); err != nil {
		t.Fatalf("request id %q is not a uuid", reqID)
	}
	if got := w.Header().Get(RequestIDHeader); got != reqID {
		t.Fatalf("response %s = %q, want %q", RequestIDHeader, got, reqID)
	}
	if o, _ := conn.args[argOrg].(*uuid.UUID); o == nil || *o != org {
		t.Fatalf("org = %v", conn.args[argOrg])
	}
	if p, _ := conn.args[argProject].(*uuid.UUID); p == nil || *p != project {
		t.Fatalf("project = %v", conn.args[argProject])
	}
	if got := strArg(conn.args[argTargetType]) + "/" + strArg(conn.args[argTargetID]) + "/" + strArg(conn.args[argTargetLabel]); got != "api_key/k1/ci" {
		t.Fatalf("target = %s", got)
	}
	if got := strArg(conn.args[argRequestID]); got != reqID {
		t.Fatalf("request id arg = %s", got)
	}
	var ch struct {
		Previous map[string][]string `json:"previous"`
		Next     map[string][]string `json:"next"`
	}
	if err := json.Unmarshal(conn.args[argChanges].([]byte), &ch); err != nil {
		t.Fatal(err)
	}
	if len(ch.Previous["scopes"]) != 1 || len(ch.Next["scopes"]) != 2 {
		t.Fatalf("changes = %s", conn.args[argChanges])
	}
}

func TestRecordLeavesUnsetScopeNull(t *testing.T) {
	conn := &fakeDB{}
	if err := New(conn).Record(context.Background(), Event{Kind: LoginSucceeded}); err != nil {
		t.Fatal(err)
	}
	for _, i := range []int{argOrg, argProject} {
		if u, _ := conn.args[i].(*uuid.UUID); u != nil {
			t.Errorf("arg %d = %v, want NULL", i, u)
		}
	}
	for _, i := range []int{argTargetType, argTargetID, argTargetLabel, argRequestID} {
		if s, _ := conn.args[i].(*string); s != nil {
			t.Errorf("arg %d = %q, want NULL", i, *s)
		}
	}
	if c, _ := conn.args[argChanges].([]byte); c != nil {
		t.Errorf("changes = %s, want NULL", c)
	}
}

func TestRecordRefusesSecretsInChanges(t *testing.T) {
	rawKey := "apl_live_" + "Q2hhbmdlTWVJc05vdEFSZWFsS2V5QnV0TG9va3NMaWtlT25l"
	cases := map[string]*Changes{
		"client secret":        {Next: map[string]any{"issuer": "https://idp.example.com", "client_secret": "s3cr3t"}},
		"sealed client secret": {Previous: map[string]any{"client_secret_enc": "AAAA"}},
		"key hash":             {Next: map[string]any{"key_hash": "deadbeef"}},
		"raw key field":        {Next: map[string]any{"raw_key": rawKey}},
		"key material value":   {Next: map[string]any{"note": rawKey}},
		"nested secret":        {Next: map[string]any{"webhook": map[string]any{"signing_secret": "x"}}},
		"key in list":          {Next: map[string]any{"keys": []any{rawKey}}},
		"struct field": {Next: struct {
			Password string `json:"password"`
		}{"hunter2"}},
	}
	for name, ch := range cases {
		t.Run(name, func(t *testing.T) {
			conn := &fakeDB{}
			err := New(conn).Record(context.Background(), Event{Kind: SSOUpdated, Changes: ch})
			if !errors.Is(err, ErrSecret) {
				t.Fatalf("err = %v, want ErrSecret", err)
			}
			if conn.args != nil {
				t.Fatal("a change holding a secret must not be written")
			}
		})
	}
}

func TestRecordAcceptsRedactedChanges(t *testing.T) {
	conn := &fakeDB{}
	ch := &Changes{
		Previous: Redact(map[string]any{"client_id": "app", "client_secret": "old"}),
		Next:     Redact(map[string]any{"client_id": "app", "client_secret": "new", "prefix": "apl_live_abc"}),
	}
	if err := New(conn).Record(context.Background(), Event{Kind: SSOUpdated, Changes: ch}); err != nil {
		t.Fatal(err)
	}
	var got struct {
		Previous map[string]any `json:"previous"`
		Next     map[string]any `json:"next"`
	}
	if err := json.Unmarshal(conn.args[argChanges].([]byte), &got); err != nil {
		t.Fatal(err)
	}
	if got.Previous["client_secret"] != Redacted || got.Next["client_secret"] != Redacted || got.Next["prefix"] != "apl_live_abc" {
		t.Fatalf("changes = %s", conn.args[argChanges])
	}
}

func TestRedact(t *testing.T) {
	in := map[string]any{
		"name":           "ci",
		"token":          "tok",
		"unset":          nil,
		"Secret":         "x",
		"nested":         map[string]any{"refresh_token": "r", "keep": 1},
		"list":           []any{map[string]any{"password": "p"}},
		"api_key_secret": nil,
	}
	out := Redact(in)
	if out["name"] != "ci" || out["token"] != Redacted || out["Secret"] != Redacted || out["unset"] != nil || out["api_key_secret"] != nil {
		t.Fatalf("out = %v", out)
	}
	nested := out["nested"].(map[string]any)
	if nested["refresh_token"] != Redacted || nested["keep"] != 1 {
		t.Fatalf("nested = %v", nested)
	}
	if out["list"].([]any)[0].(map[string]any)["password"] != Redacted {
		t.Fatalf("list = %v", out["list"])
	}
	if in["token"] != "tok" {
		t.Fatal("Redact must not change its input")
	}
	if Redact(nil) != nil {
		t.Fatal("Redact(nil) != nil")
	}
}

func TestIsSecretField(t *testing.T) {
	for _, f := range []string{"secret", "client_secret", "CLIENT_SECRET", "key", "key_hash", "token", "signing_secret", "code", "password"} {
		if !IsSecretField(f) {
			t.Errorf("%s should be secret", f)
		}
	}
	for _, f := range []string{"name", "prefix", "scopes", "client_id", "secret_changed", "issuer", "role", "key_id"} {
		if IsSecretField(f) {
			t.Errorf("%s should not be secret", f)
		}
	}
}
