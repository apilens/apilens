package privacy

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func TestDefaultsQuery(t *testing.T) {
	r := Default
	for _, tc := range []struct{ in, want string }{
		{"/orders", "/orders"},
		{"/orders?page=2", "/orders?page=2"},
		{"/orders?token=abc", "/orders?token=[redacted]"},
		{"/a?page=2&api_key=k1&apikey=k2&API-KEY=k3&x=1", "/a?page=2&api_key=[redacted]&apikey=[redacted]&API-KEY=[redacted]&x=1"},
		{"/a?Authorization=x&client_secret=s&password=p&pwd=q", "/a?Authorization=[redacted]&client_secret=[redacted]&password=[redacted]&pwd=[redacted]"},
		{"/a?access%5Ftoken=abc&q=caf%C3%A9", "/a?access%5Ftoken=[redacted]&q=caf%C3%A9"},
		{"/a?token=abc#frag", "/a?token=[redacted]#frag"},
		{"/a?token&x=1", "/a?token&x=1"},
		{"/a?token=[redacted]", "/a?token=[redacted]"},
	} {
		if got := r.RawPath(tc.in); got != tc.want {
			t.Errorf("RawPath(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestDefaultsHeaders(t *testing.T) {
	r := Default
	in := `{"authorization":"Bearer abc","X-Api-Key":"k","cookie":"s=1","x-csrf-token":"c","x-amz-security-token":"t","x-client-secret":"s","accept":"application/json","x-forwarded-for":["1.2.3.4"]}`
	var got map[string]any
	if err := json.Unmarshal([]byte(r.Headers(in)), &got); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"authorization", "X-Api-Key", "cookie", "x-csrf-token", "x-amz-security-token", "x-client-secret"} {
		if got[k] != Redacted {
			t.Errorf("%s = %v, want redacted", k, got[k])
		}
	}
	if got["accept"] != "application/json" {
		t.Errorf("accept = %v", got["accept"])
	}
	if v, _ := got["x-forwarded-for"].([]any); len(v) != 1 {
		t.Errorf("x-forwarded-for = %v", got["x-forwarded-for"])
	}

	// Unchanged input is returned byte for byte.
	clean := `{"b":"2", "a":"1"}`
	if got := r.Headers(clean); got != clean {
		t.Errorf("clean headers rewritten: %q", got)
	}
	// Exact sensitive names apply even when no pattern matches them.
	if !r.HeaderMatches("Set-Cookie") || !r.HeaderMatches("proxy-authorization") || r.HeaderMatches("content-type") {
		t.Error("HeaderMatches")
	}
	// Non-JSON header text falls back to key: value masking.
	if got := r.Headers("Authorization: Bearer abc\nAccept: */*"); got != "Authorization: [redacted]\nAccept: */*" {
		t.Errorf("text headers = %q", got)
	}
}

func TestDefaultsBody(t *testing.T) {
	r := Default
	in := `{"user":{"email":"a@example.com","password":"hunter2","pin":1234},"card_number":4111111111111111,"cardNumber":"4111","cvv":"123","ssn":"078-05-1120","tokens":["a","b"],"auth":{"user":"u"},"items":[{"secret":"s","n":1}],"ok":true,"note":"<b>&</b>"}`
	out := r.Body(in)
	var got map[string]any
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	user := got["user"].(map[string]any)
	if user["password"] != Redacted || user["email"] != "a@example.com" || user["pin"] != float64(1234) {
		t.Errorf("user = %v", user)
	}
	for _, k := range []string{"card_number", "cardNumber", "cvv", "ssn"} {
		if got[k] != Redacted {
			t.Errorf("%s = %v", k, got[k])
		}
	}
	// Containers under a matching name are walked, not replaced.
	if v := got["tokens"].([]any); len(v) != 2 || v[0] != "a" {
		t.Errorf("tokens = %v", got["tokens"])
	}
	if a := got["auth"].(map[string]any); a["user"] != "u" {
		t.Errorf("auth = %v", got["auth"])
	}
	if it := got["items"].([]any)[0].(map[string]any); it["secret"] != Redacted || it["n"] != float64(1) {
		t.Errorf("items = %v", got["items"])
	}
	if got["ok"] != true || got["note"] != "<b>&</b>" {
		t.Errorf("ok/note = %v %v", got["ok"], got["note"])
	}
	if strings.Contains(out, "\\u003c") {
		t.Errorf("HTML escaped: %s", out)
	}
	// Large numbers survive untouched.
	if got := r.Body(`{"id":12345678901234567890,"password":1}`); got != `{"id":12345678901234567890,"password":"[redacted]"}` {
		t.Errorf("numbers = %s", got)
	}

	for _, s := range []string{"", "plain text", `{"a":1}`, `[1,2]`, `"string"`, `{"a":1} trailing`} {
		if got := r.Body(s); got != s {
			t.Errorf("Body(%q) = %q, want unchanged", s, got)
		}
	}
	// Truncated JSON and form bodies are masked as text.
	if got := r.Body(`{"password":"hunter2","note":"abc`); got != `{"password":"[redacted]","note":"abc` {
		t.Errorf("truncated = %s", got)
	}
	if got := r.Body("user=ada&password=hunter2"); got != "user=ada&password=[redacted]" {
		t.Errorf("form = %s", got)
	}
	// Idempotent.
	if once := r.Body(in); r.Body(once) != once {
		t.Error("not idempotent")
	}
}

func TestText(t *testing.T) {
	r := Default
	for _, tc := range []struct{ in, want string }{
		{"payment failed", "payment failed"},
		{"login failed token=abc user=ada", "login failed token=[redacted] user=ada"},
		{"Authorization: Bearer abc.def", "Authorization: [redacted]"},
		{`retry with api_key="k 1", attempt=2`, `retry with api_key="[redacted]", attempt=2`},
		{`body {"password": "hunter2", "ok": 1}`, `body {"password": "[redacted]", "ok": 1}`},
		{"GET /a?secret=s&x=1 500", "GET /a?secret=[redacted]&x=1 500"},
		{"Error: something broke", "Error: something broke"},
		{"token=[redacted]", "token=[redacted]"},
	} {
		if got := r.Text(tc.in); got != tc.want {
			t.Errorf("Text(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestCompilePolicies(t *testing.T) {
	r, err := Compile(Policy{QueryParams: []string{`^email$`}}, Policy{Headers: []string{`^x-tenant$`}, BodyFields: []string{`^iban$`}})
	if err != nil {
		t.Fatal(err)
	}
	if got := r.RawPath("/a?email=a@example.com&emails=2&token=t"); got != "/a?email=[redacted]&emails=2&token=[redacted]" {
		t.Errorf("query = %s", got)
	}
	if got := r.Headers(`{"X-Tenant":"acme","x-tenants":"no"}`); got != `{"X-Tenant":"[redacted]","x-tenants":"no"}` {
		t.Errorf("headers = %s", got)
	}
	if got := r.Body(`{"IBAN":"DE00","password":"p"}`); got != `{"IBAN":"[redacted]","password":"[redacted]"}` {
		t.Errorf("body = %s", got)
	}
	// Policy patterns reach free text too.
	if got := r.Text("charge iban=DE00 email=a@example.com"); got != "charge iban=[redacted] email=[redacted]" {
		t.Errorf("text = %s", got)
	}
	// The defaults never go away.
	if Default.RawPath("/a?email=x") != "/a?email=x" {
		t.Error("policy leaked into Default")
	}
	if _, err := Compile(Policy{BodyFields: []string{"("}}); err == nil {
		t.Error("invalid pattern compiled")
	}
}

func TestNormalize(t *testing.T) {
	p, err := Policy{QueryParams: []string{" email ", "", "email", "^ssn$"}}.Normalize()
	if err != nil || len(p.QueryParams) != 2 || p.QueryParams[0] != "email" || p.Headers == nil || p.BodyFields == nil {
		t.Fatalf("normalize = %+v, %v", p, err)
	}
	var inv *InvalidPatternError
	if _, err := (Policy{Headers: []string{"ok", "pass(?=word)"}}).Normalize(); !errors.As(err, &inv) || inv.Field != "mask_headers" || inv.Index != 1 {
		t.Fatalf("lookahead: %v", err)
	}
	if _, err := (Policy{BodyFields: []string{strings.Repeat("a", MaxPatternLen+1)}}).Normalize(); !errors.As(err, &inv) {
		t.Fatalf("long: %v", err)
	}
	many := make([]string, MaxPatterns+1)
	for i := range many {
		many[i] = "f" + strings.Repeat("x", i)
	}
	if _, err := (Policy{BodyFields: many}).Normalize(); !errors.As(err, &inv) {
		t.Fatalf("many: %v", err)
	}
}

func TestMaskJSONScanner(t *testing.T) {
	r := Default
	for _, tc := range []struct{ in, want string }{
		// Formatting and key order are kept.
		{"{\n  \"z\": 1,\n  \"password\" : \"p\"\n}", "{\n  \"z\": 1,\n  \"password\" : \"[redacted]\"\n}"},
		// Escaped keys are decoded before matching; escaped values are skipped whole.
		{`{"password":"a\"b","note":"x \" password: y"}`, `{"password":"[redacted]","note":"x \" password: y"}`},
		// Strings holding JSON punctuation do not confuse the scanner.
		{`{"a":"{\"token\":1}","b":["]","}"],"token":-1.5e3}`, `{"a":"{\"token\":1}","b":["]","}"],"token":"[redacted]"}`},
		// Values that are not strings or numbers under a matching key stay.
		{`{"token":null,"secret":true,"auth":[{"password":"p"}]}`, `{"token":null,"secret":true,"auth":[{"password":"[redacted]"}]}`},
		// Top-level arrays.
		{`[{"ssn":"1"},{"ssn":"2"}]`, `[{"ssn":"[redacted]"},{"ssn":"[redacted]"}]`},
	} {
		got := r.Body(tc.in)
		if got != tc.want {
			t.Errorf("Body(%s)\n got %s\nwant %s", tc.in, got, tc.want)
		}
		if !json.Valid([]byte(got)) {
			t.Errorf("Body(%s) is not JSON: %s", tc.in, got)
		}
	}

	// Beyond the depth limit fields are left alone.
	deep := strings.Repeat(`{"a":`, maxBodyDepth+2) + `{"password":"p"}` + strings.Repeat("}", maxBodyDepth+2)
	if got := r.Body(deep); got != deep {
		t.Error("masked beyond the depth limit")
	}
	shallow := strings.Repeat(`{"a":`, 3) + `{"password":"p"}` + strings.Repeat("}", 3)
	if got := r.Body(shallow); strings.Contains(got, `"p"`) {
		t.Error("not masked within the depth limit")
	}

	// Headers: any value type of a top-level member, nested members ignored.
	h := `{"cookie":["a=1","b=2"],"x-meta":{"token":"t"},"authorization":{"k":"v"}}`
	if got := r.Headers(h); got != `{"cookie":"[redacted]","x-meta":{"token":"t"},"authorization":"[redacted]"}` {
		t.Errorf("headers = %s", got)
	}
}

func FuzzBodyStaysJSON(f *testing.F) {
	for _, s := range []string{`{"password":"p","a":[1,{"token":2}]}`, `[{"ssn":"x"}]`, `{"a\"b":{"secret":1e5}}`} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) {
		if !json.Valid([]byte(s)) {
			return
		}
		if got := Default.Body(s); !json.Valid([]byte(got)) {
			t.Fatalf("Body(%q) = %q is not JSON", s, got)
		}
		if got := Default.Headers(s); !json.Valid([]byte(got)) {
			t.Fatalf("Headers(%q) = %q is not JSON", s, got)
		}
	})
}
