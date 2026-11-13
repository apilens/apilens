package audit

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// fakeDB captures the arguments of the InsertAuditEvent query.
type fakeDB struct {
	args []any
}

func (f *fakeDB) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, nil
}

func (f *fakeDB) Query(context.Context, string, ...any) (pgx.Rows, error) { return nil, nil }

func (f *fakeDB) QueryRow(_ context.Context, _ string, args ...any) pgx.Row {
	f.args = args
	return okRow{}
}

type okRow struct{}

func (okRow) Scan(...any) error { return nil }

// fakeTx is a pgx.Tx whose QueryRow is captured; other methods are unused.
type fakeTx struct {
	pgx.Tx
	db fakeDB
}

func (t *fakeTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return t.db.QueryRow(ctx, sql, args...)
}

// InsertAuditEvent argument positions.
const (
	argUser = iota
	argActor
	argEvent
	argIP
	argUserAgent
	argMeta
	argOrg
	argProject
	argTargetType
	argTargetID
	argTargetLabel
	argRequestID
	argChanges
)

func TestRecordTakesIPAndUserAgentFromRequestContext(t *testing.T) {
	cases := []struct {
		remote string
		wantIP string
	}{
		{"203.0.113.7:51234", "203.0.113.7"},
		{"[2001:db8::1]:443", "2001:db8::1"},
		{"[::ffff:198.51.100.2]:80", "198.51.100.2"},
		{"[fe80::1%eth0]:80", "fe80::1"},
	}
	for _, tc := range cases {
		t.Run(tc.remote, func(t *testing.T) {
			conn := &fakeDB{}
			rec := New(conn)
			user := uuid.New()

			h := Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if err := rec.Record(r.Context(), Event{User: &user, Actor: &user, Kind: LoginSucceeded, Meta: map[string]any{"method": "passkey"}}); err != nil {
					t.Fatal(err)
				}
			}))
			req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", nil)
			req.RemoteAddr = tc.remote
			req.Header.Set("User-Agent", "Mozilla/5.0 test")
			req.Header.Set("X-Forwarded-For", "10.9.9.9") // must be ignored
			h.ServeHTTP(httptest.NewRecorder(), req)

			if conn.args == nil {
				t.Fatal("no insert")
			}
			ip, _ := conn.args[argIP].(*netip.Addr)
			if ip == nil || ip.String() != tc.wantIP {
				t.Fatalf("ip = %v, want %s", conn.args[argIP], tc.wantIP)
			}
			if ua := conn.args[argUserAgent]; ua != "Mozilla/5.0 test" {
				t.Fatalf("user agent = %v", ua)
			}
			if ev := conn.args[argEvent]; ev != "login.succeeded" {
				t.Fatalf("event = %v", ev)
			}
			if u, _ := conn.args[argUser].(*uuid.UUID); u == nil || *u != user {
				t.Fatalf("user = %v", conn.args[argUser])
			}
			var meta map[string]string
			if err := json.Unmarshal(conn.args[argMeta].([]byte), &meta); err != nil || meta["method"] != "passkey" {
				t.Fatalf("meta = %s %v", conn.args[argMeta], err)
			}
		})
	}
}

func TestRecordWithoutRequest(t *testing.T) {
	conn := &fakeDB{}
	if err := New(conn).Record(context.Background(), Event{Kind: OrgCreated}); err != nil {
		t.Fatal(err)
	}
	if ip, _ := conn.args[argIP].(*netip.Addr); ip != nil {
		t.Fatalf("ip = %v, want NULL", ip)
	}
	if conn.args[argUserAgent] != "" || string(conn.args[argMeta].([]byte)) != "{}" {
		t.Fatalf("args = %v", conn.args)
	}
	if u, _ := conn.args[argUser].(*uuid.UUID); u != nil {
		t.Fatalf("user = %v, want NULL", u)
	}
}

func TestUserAgentIsBounded(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("User-Agent", strings.Repeat("a", 4096))
	if got := len(FromHTTP(req).UserAgent); got != maxUserAgent {
		t.Fatalf("len = %d", got)
	}
}

func TestRecordUsesContextTx(t *testing.T) {
	pool := &fakeDB{}
	tx := &fakeTx{}
	ctx := WithTx(context.Background(), tx)
	if err := New(pool).Record(ctx, Event{Kind: UserCreated}); err != nil {
		t.Fatal(err)
	}
	if pool.args != nil || tx.db.args == nil {
		t.Fatalf("event should be written in the context tx (pool=%v tx=%v)", pool.args, tx.db.args)
	}
}

func TestRecordRejectsUnknownKind(t *testing.T) {
	conn := &fakeDB{}
	if err := New(conn).Record(context.Background(), Event{Kind: "login.maybe"}); err == nil {
		t.Fatal("want error for unknown kind")
	}
	if conn.args != nil {
		t.Fatal("unknown kind must not be written")
	}
}

func TestCatalogue(t *testing.T) {
	want := []string{
		"user.created", "user.updated", "user.deleted", "user.restored", "login.succeeded", "login.failed", "login.requested", "session.revoked", "session.reuse_detected",
		"email.changed", "passkey.added", "passkey.removed", "passkey.renamed", "totp.enabled", "totp.disabled",
		"recovery.requested", "recovery.confirmed", "recovery.cancelled", "oauth.linked", "oauth.unlinked",
		"org.created", "org.updated", "org.deleted", "member.added", "member.role_changed", "member.removed", "member.joined", "invitation.sent", "invitation.accepted",
		"api_key.created", "api_key.revoked", "sso.updated", "sso.deleted", "capture_policy.updated",
		"api_key.updated", "app.created", "app.archived", "app.restored", "app.renamed", "app.merged", "app.deleted", "app.acknowledged",
		"session.reauthenticated", "session.reauth_failed",
		"api_key.rotated",
		"project.created", "project.updated", "environment.added", "environment.updated", "environment.removed", "privacy_policy.updated",
		"invitation.revoked", "alert_rule.created", "alert_rule.updated", "alert_rule.deleted", "alert_channel.created", "alert_channel.updated",
		"alert_channel.deleted", "health_check.created", "health_check.deleted", "app_settings.updated", "endpoint_settings.updated",
		"project_member.added", "project_member.role_changed", "project_member.removed", "project.access_changed",
		"audit_log.exported", "api_key.expired",
	}
	got := Kinds()
	if len(got) != len(want) {
		t.Fatalf("got %d kinds, want %d", len(got), len(want))
	}
	for i, k := range got {
		if string(k) != want[i] {
			t.Errorf("kind %d = %s, want %s", i, k, want[i])
		}
	}
}

// docs/architecture/overview.md must list every event kind.
func TestCatalogueDocumented(t *testing.T) {
	doc, err := os.ReadFile("../../../docs/architecture/overview.md")
	if err != nil {
		t.Fatalf("read doc: %v", err)
	}
	rows := map[string]bool{}
	for _, line := range strings.Split(string(doc), "\n") {
		cells := strings.Split(line, "|")
		if len(cells) < 3 {
			continue
		}
		rows[strings.Trim(strings.TrimSpace(cells[1]), "`")] = true
	}
	for _, k := range Kinds() {
		if !rows[string(k)] {
			t.Errorf("%s missing from docs/architecture/overview.md", k)
		}
	}
}

func TestDiff(t *testing.T) {
	if c := Diff(map[string]any{"name": "a", "n": 1}, map[string]any{"name": "a", "n": 1}); c != nil {
		t.Fatalf("unchanged = %+v, want nil", c)
	}
	c := Diff(map[string]any{"name": "a", "n": 1}, map[string]any{"name": "b", "n": 1})
	if c == nil || len(c.Previous.(map[string]any)) != 1 || c.Previous.(map[string]any)["name"] != "a" || c.Next.(map[string]any)["name"] != "b" {
		t.Fatalf("changed = %+v, want only name", c)
	}
	c = Diff(nil, map[string]any{"name": "a", "client_secret": "s3cret"})
	if c.Previous != nil || c.Next.(map[string]any)["client_secret"] != Redacted {
		t.Fatalf("created = %+v, want next with the secret redacted", c)
	}
	c = Diff(map[string]any{"name": "a"}, nil)
	if c.Next != nil || c.Previous.(map[string]any)["name"] != "a" {
		t.Fatalf("deleted = %+v", c)
	}
}
