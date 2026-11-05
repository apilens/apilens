package app

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeTemp(t *testing.T, name, content string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestPIIAuditCSVHits(t *testing.T) {
	csv := writeTemp(t, "export.csv", "method,path,request_payload\nPOST,/users,\"{\"\"email\"\":\"\"jane@example.com\"\"}\"\nGET,/health,ok\n")
	var stdout, stderr bytes.Buffer
	if code := Main([]string{"pii-audit", "-csv=" + csv}, &stdout, &stderr, nil); code != 1 {
		t.Fatalf("exit code = %d, want 1 (stderr %q)", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "ENDPOINT") || !strings.Contains(stdout.String(), "POST /users") || strings.Contains(stdout.String(), "jane@example.com") {
		t.Fatalf("stdout = %q", stdout.String())
	}
	if !strings.Contains(stderr.String(), "scanned 2 records, 1 hits") {
		t.Fatalf("stderr = %q", stderr.String())
	}
}

func TestPIIAuditCSVClean(t *testing.T) {
	csv := writeTemp(t, "export.csv", "method,path,request_payload\nPOST,/users,\"{\"\"email\"\":\"\"[redacted]\"\"}\"\n")
	var stdout, stderr bytes.Buffer
	if code := Main([]string{"pii-audit", "-csv=" + csv, "-format=json"}, &stdout, &stderr, nil); code != 0 {
		t.Fatalf("exit code = %d, want 0 (stderr %q)", code, stderr.String())
	}
	if strings.TrimSpace(stdout.String()) != "[]" {
		t.Fatalf("stdout = %q", stdout.String())
	}
}

func TestPIIAuditCustomPatterns(t *testing.T) {
	csv := writeTemp(t, "export.csv", "path,request_payload\n/members,M-123456 jane@example.com POL99\n")
	patterns := writeTemp(t, "patterns.txt", "# custom\npolicy=POL\\d+\n")
	var stdout, stderr bytes.Buffer
	args := []string{"pii-audit", "-csv=" + csv, "-format=json", "-no-defaults", `-pattern=member=M-\d{6}`, "-patterns-file=" + patterns}
	if code := Main(args, &stdout, &stderr, nil); code != 1 {
		t.Fatalf("exit code = %d, want 1 (stderr %q)", code, stderr.String())
	}
	var got []struct{ Pattern string }
	if err := json.Unmarshal(stdout.Bytes(), &got); err != nil {
		t.Fatalf("%v: %s", err, stdout.String())
	}
	if len(got) != 2 || got[0].Pattern != "member" || got[1].Pattern != "policy" {
		t.Fatalf("findings = %+v, want member and policy only", got)
	}
}

func TestPIIAuditRejectsBadFlags(t *testing.T) {
	csv := writeTemp(t, "export.csv", "path\n/\n")
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"pii-audit"}, "exactly one of -csv or -project"},
		{[]string{"pii-audit", "-csv=" + csv, "-project=dev"}, "exactly one of -csv or -project"},
		{[]string{"pii-audit", "-csv=" + csv, "-format=xml"}, `unknown -format "xml"`},
		{[]string{"pii-audit", "-csv=" + csv, "-pattern=broken"}, "want name=regex"},
		{[]string{"pii-audit", "-csv=" + csv, "-no-defaults"}, "no detectors"},
	} {
		var stderr bytes.Buffer
		if code := Main(tc.args, &bytes.Buffer{}, &stderr, nil); code != 1 {
			t.Fatalf("%v: exit code = %d, want 1", tc.args, code)
		}
		if !strings.Contains(stderr.String(), tc.want) {
			t.Fatalf("%v: stderr = %q, want %q", tc.args, stderr.String(), tc.want)
		}
	}
}
