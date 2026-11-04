package email

import (
	"flag"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"
)

var update = flag.Bool("update", false, "rewrite testdata/golden from the built-in templates")

const testUIURL = "https://app.example.com"

// sampleData is the job data for each built-in template. Times are strings,
// as they arrive after the job's JSON round trip.
var sampleData = map[string]map[string]any{
	"auth_code":       {"code": "482913", "token": "tok_abc-123/xyz", "email": "ada+test@example.com", "expires_in": "15 minutes"},
	"auth_no_account": {"email": "ada+test@example.com"},
	"new_signin": {
		"device": "Firefox on macOS", "ip": "203.0.113.7", "time": "2026-11-04T09:30:00Z",
	},
	"invitation": {
		"org": "Acme <Labs>", "inviter": "Ada Lovelace", "role": "member",
		"token": "inv_9f8e7d", "expires_at": "2026-11-11T09:30:00Z",
	},
	"security_change": {
		"change": "passkey_added", "device": "Safari on iOS", "ip": "2001:db8::1", "time": "2026-11-04T09:30:00Z",
	},
	"recovery_requested": {
		"token": "rec_1a2b3c", "ip": "198.51.100.4", "time": "2026-11-04T09:30:00Z", "ready_at": "2026-11-05T09:30:00Z",
	},
	"recovery_ready": {"token": "rec_1a2b3c"},
}

func defaultRenderer(t *testing.T) *Renderer {
	t.Helper()
	r, err := DefaultRenderer(WithPublicUIURL(testUIURL + "/"))
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// TestTemplatesGolden renders every built-in template with sample data and
// compares it to testdata/golden. Run with -update after changing a template
// and review the diff (open the .html files in a browser, light and dark).
func TestTemplatesGolden(t *testing.T) {
	r := defaultRenderer(t)
	if got, want := strings.Join(r.Names(), ","), strings.Join(slices.Sorted(maps.Keys(sampleData)), ","); got != want {
		t.Fatalf("templates = %s; sample data for %s", got, want)
	}
	for _, name := range r.Names() {
		t.Run(name, func(t *testing.T) {
			msg, err := r.Render(name, "user@example.com", sampleData[name])
			if err != nil {
				t.Fatal(err)
			}
			if msg.HTML == "" {
				t.Fatal("no HTML part")
			}
			checkGolden(t, name+".txt", "Subject: "+msg.Subject+"\n\n"+msg.Text)
			checkGolden(t, name+".html", msg.HTML+"\n")
		})
	}
}

func checkGolden(t *testing.T, file, got string) {
	t.Helper()
	path := filepath.Join("testdata", "golden", file)
	if *update {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (run go test -update)", err)
	}
	if got != string(want) {
		t.Errorf("%s differs from golden (run go test -update and review the diff)\n--- got ---\n%s", path, got)
	}
}

var (
	urlPattern = regexp.MustCompile(`https?://[^\s"'<>)]+`)
	// Copy rules: no exclamation marks, no "Oops".
	bannedCopy = regexp.MustCompile(`!|(?i)\boops\b`)
)

// TestTemplatesCopyAndLinks checks rules every template must follow, for
// every variant of security_change.
func TestTemplatesCopyAndLinks(t *testing.T) {
	r := defaultRenderer(t)
	type tc struct {
		name string
		data map[string]any
	}
	var cases []tc
	for name, data := range sampleData {
		if name != "security_change" { // covered below, once per change
			cases = append(cases, tc{name, data})
		}
	}
	for _, change := range securityChanges {
		data := map[string]any{}
		for k, v := range sampleData["security_change"] {
			data[k] = v
		}
		data["change"] = change
		cases = append(cases, tc{"security_change", data})
	}
	subjects := map[string]bool{}
	for _, c := range cases {
		msg, err := r.Render(c.name, "user@example.com", c.data)
		if err != nil {
			t.Fatalf("%s %v: %v", c.name, c.data["change"], err)
		}
		label := c.name
		if ch, ok := c.data["change"]; ok {
			label += "/" + ch.(string)
		}
		subjects[msg.Subject] = true
		// Sentence case: first letter upper, no Title Case Words beyond names.
		if s := msg.Subject; s == "" || strings.ToUpper(s[:1]) != s[:1] || strings.HasSuffix(s, ".") {
			t.Errorf("%s: subject %q not in sentence case", label, s)
		}
		html := stripDoctypeAndCSS(msg.HTML)
		for part, body := range map[string]string{"subject": msg.Subject, "text": msg.Text, "html": html} {
			if m := bannedCopy.FindString(body); m != "" {
				t.Errorf("%s %s: banned copy %q", label, part, m)
			}
			for _, u := range urlPattern.FindAllString(body, -1) {
				if !strings.HasPrefix(u, testUIURL+"/") {
					t.Errorf("%s %s: link %q not on identity.public_ui_url", label, part, u)
				}
			}
		}
		if strings.Contains(strings.ToLower(msg.HTML), "<img") {
			t.Errorf("%s: HTML has an image", label)
		}
		if !strings.Contains(msg.HTML, `name="color-scheme" content="light dark"`) ||
			!strings.Contains(msg.HTML, "prefers-color-scheme: dark") {
			t.Errorf("%s: HTML does not declare a dark scheme", label)
		}
	}
	if len(subjects) != len(cases) {
		t.Errorf("%d subjects for %d emails; each should be distinct", len(subjects), len(cases))
	}
}

// stripDoctypeAndCSS drops the parts of the HTML that legitimately contain
// "!" (<!doctype>, !important) so the copy check sees only words.
func stripDoctypeAndCSS(html string) string {
	html = regexp.MustCompile(`(?s)<style>.*?</style>`).ReplaceAllString(html, "")
	return strings.ReplaceAll(html, "<!doctype html>", "")
}

func TestSecurityChangeUnknown(t *testing.T) {
	data := map[string]any{}
	for k, v := range sampleData["security_change"] {
		data[k] = v
	}
	data["change"] = "nope"
	if _, err := defaultRenderer(t).Render("security_change", "a@example.com", data); err == nil {
		t.Error("unknown change rendered")
	}
}

func TestTemplatesMissingData(t *testing.T) {
	r := defaultRenderer(t)
	for name, data := range sampleData {
		for key := range data {
			partial := map[string]any{}
			for k, v := range data {
				if k != key {
					partial[k] = v
				}
			}
			if _, err := r.Render(name, "a@example.com", partial); err == nil {
				t.Errorf("%s without %s rendered", name, key)
			}
		}
	}
}

func TestLink(t *testing.T) {
	for base, want := range map[string]string{
		"https://app.example.com":       "https://app.example.com/invite/a%2Fb?next=%2Fx+y&t=1",
		"https://app.example.com/":      "https://app.example.com/invite/a%2Fb?next=%2Fx+y&t=1",
		"https://example.com/console/":  "https://example.com/console/invite/a%2Fb?next=%2Fx+y&t=1",
		"http://localhost:3000?x=1#top": "http://localhost:3000/invite/a%2Fb?next=%2Fx+y&t=1",
	} {
		r, err := NewRenderer(testTemplates, WithPublicUIURL(base))
		if err != nil {
			t.Fatal(err)
		}
		got, err := r.link("/invite/a%2Fb", "next", "/x y", "t", "1")
		if err != nil || got != want {
			t.Errorf("%s: link = %q, %v; want %q", base, got, err, want)
		}
	}
	r, _ := NewRenderer(testTemplates, WithPublicUIURL("https://app.example.com"))
	for _, bad := range [][]string{{"invite"}, {"//evil.example/x"}, {"/x", "k"}, {"/x", "k", ""}} {
		if got, err := r.link(bad[0], bad[1:]...); err == nil {
			t.Errorf("link(%q) = %q, want error", bad, got)
		}
	}
	if _, err := testRenderer(t).link("/"); err == nil {
		t.Error("link without a public UI URL succeeded")
	}
	for _, bad := range []string{"", "app.example.com", "ftp://x", "https://"} {
		if _, err := NewRenderer(testTemplates, WithPublicUIURL(bad)); err == nil {
			t.Errorf("public UI URL %q accepted", bad)
		}
	}
}

func TestFormatTime(t *testing.T) {
	ts := time.Date(2026, 11, 4, 15, 30, 0, 0, time.FixedZone("IST", 5*3600+1800))
	for _, v := range []any{ts, ts.Format(time.RFC3339)} {
		if got, err := formatTime(v, "Mon, 2 Jan 2006 15:04 MST"); err != nil || got != "Wed, 4 Nov 2026 10:00 UTC" {
			t.Errorf("formatTime(%v) = %q, %v", v, got, err)
		}
	}
	for _, bad := range []any{"yesterday", 42.0, nil} {
		if _, err := formatTime(bad, time.RFC3339); err == nil {
			t.Errorf("formatTime(%v) succeeded", bad)
		}
	}
}
