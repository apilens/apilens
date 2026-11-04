package identity

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/humatest"
)

type problemBody struct {
	Title      string  `json:"title"`
	Status     int     `json:"status"`
	Detail     string  `json:"detail"`
	Code       ErrCode `json:"code"`
	RetryAfter int     `json:"retry_after"`
}

// served is the status, headers and decoded body of one problem response.
type served struct {
	StatusCode int
	Header     http.Header
}

func serveProblem(t *testing.T, err error) (served, problemBody) {
	t.Helper()
	_, api := humatest.New(t)
	huma.Get(api, "/fail", func(context.Context, *struct{}) (*struct{}, error) {
		return nil, err
	})
	rec := api.Get("/fail")
	var body problemBody
	if e := json.Unmarshal(rec.Body.Bytes(), &body); e != nil {
		t.Fatalf("decode: %v", e)
	}
	return served{StatusCode: rec.Code, Header: rec.Header()}, body
}

func TestEveryCodeServesAsProblemJSON(t *testing.T) {
	for code, entry := range catalogue {
		t.Run(string(code), func(t *testing.T) {
			resp, body := serveProblem(t, Err(code))
			if resp.StatusCode != entry.status || body.Status != entry.status {
				t.Fatalf("status = %d/%d, want %d", resp.StatusCode, body.Status, entry.status)
			}
			if ct := resp.Header.Get("Content-Type"); ct != "application/problem+json" {
				t.Fatalf("content-type = %q", ct)
			}
			if body.Code != code {
				t.Fatalf("code = %q, want %q", body.Code, code)
			}
			if body.Title == "" || body.Detail == "" {
				t.Fatalf("missing title/detail: %+v", body)
			}
			if body.RetryAfter != 0 || resp.Header.Get("Retry-After") != "" {
				t.Fatalf("unexpected retry: %+v %q", body, resp.Header.Get("Retry-After"))
			}
		})
	}
}

func TestRetryAfter(t *testing.T) {
	for _, tc := range []struct {
		wait time.Duration
		want int
	}{
		{30 * time.Second, 30},
		{1500 * time.Millisecond, 2},
		{0, 1},
	} {
		resp, body := serveProblem(t, ErrRetryAfter(CodeRateLimited, tc.wait))
		if resp.StatusCode != http.StatusTooManyRequests || body.Code != CodeRateLimited {
			t.Fatalf("%v: status %d code %q", tc.wait, resp.StatusCode, body.Code)
		}
		if body.RetryAfter != tc.want || resp.Header.Get("Retry-After") != strconv.Itoa(tc.want) {
			t.Fatalf("%v: retry_after %d header %q, want %d", tc.wait, body.RetryAfter, resp.Header.Get("Retry-After"), tc.want)
		}
	}
}

func TestUnknownCodeCollapsesToInternal(t *testing.T) {
	p := Err("no_such_code")
	if p.Code != CodeInternal || p.Status != http.StatusInternalServerError {
		t.Fatalf("got %q %d", p.Code, p.Status)
	}
	if ErrCode("no_such_code").Status() != http.StatusInternalServerError {
		t.Fatal("unknown code status")
	}
}

// The account-lookup failure modes must be indistinguishable: whatever the
// cause ("no such email" or "wrong code"), handlers answer invalid_code with a
// static body, so nothing about account existence leaks.
func TestNoEnumerationLeak(t *testing.T) {
	a, b := Err(CodeInvalidCode), Err(CodeInvalidCode)
	ja, _ := json.Marshal(a)
	jb, _ := json.Marshal(b)
	if string(ja) != string(jb) {
		t.Fatalf("invalid_code bodies differ: %s vs %s", ja, jb)
	}
	for code, e := range catalogue {
		for _, word := range []string{"exist", "not found", "no account", "unknown email", "registered email"} {
			if strings.Contains(strings.ToLower(e.title+" "+e.detail), word) {
				t.Errorf("%s copy %q hints at account existence", code, e.detail)
			}
		}
		if e.status == http.StatusNotFound {
			t.Errorf("%s uses 404, which reveals existence", code)
		}
	}
}

// docs/architecture/identity.md must document every code with its status.
func TestCatalogueDocumented(t *testing.T) {
	doc, err := os.ReadFile("../../docs/architecture/identity.md")
	if err != nil {
		t.Fatalf("read doc: %v", err)
	}
	rows := map[string]string{}
	for _, line := range strings.Split(string(doc), "\n") {
		cells := strings.Split(line, "|")
		if len(cells) < 4 {
			continue
		}
		code := strings.Trim(strings.TrimSpace(cells[1]), "`")
		rows[code] = strings.TrimSpace(cells[2])
	}
	for code, e := range catalogue {
		status, ok := rows[string(code)]
		if !ok {
			t.Errorf("%s missing from docs/architecture/identity.md", code)
			continue
		}
		if !strings.HasPrefix(status, strconv.Itoa(e.status)) {
			t.Errorf("%s documented as %q, want %d", code, status, e.status)
		}
	}
}
