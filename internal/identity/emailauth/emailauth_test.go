package emailauth

import (
	"context"
	"encoding/base64"
	"errors"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/identity/store/db"
)

// fakeStore is an in-memory Store with the same semantics as the SQL queries.
type fakeStore struct {
	mu      sync.Mutex
	now     func() time.Time
	rows    []db.AuthEmailToken
	lookups int // GetLatestUnconsumedEmailTokenForEmail calls
	failTx  error
	failGet error
}

func (f *fakeStore) live(r *db.AuthEmailToken) bool {
	return r.ConsumedAt == nil && f.now().Before(r.ExpiresAt)
}

func (f *fakeStore) InTx(_ context.Context, fn func(Queries) error) error {
	if f.failTx != nil {
		return f.failTx
	}
	f.mu.Lock()
	snapshot := append([]db.AuthEmailToken(nil), f.rows...)
	f.mu.Unlock()
	if err := fn(f); err != nil {
		f.mu.Lock()
		f.rows = snapshot
		f.mu.Unlock()
		return err
	}
	return nil
}

func (f *fakeStore) CreateEmailToken(_ context.Context, a db.CreateEmailTokenParams) (db.AuthEmailToken, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, r := range f.rows {
		if r.LinkTokenHash == a.LinkTokenHash {
			return db.AuthEmailToken{}, errors.New("duplicate link_token_hash")
		}
	}
	r := db.AuthEmailToken{
		ID: a.ID, Email: a.Email, Intent: a.Intent, UserID: a.UserID, LinkTokenHash: a.LinkTokenHash,
		CodeHash: a.CodeHash, NextPath: a.NextPath, Ip: a.Ip, UserAgent: a.UserAgent,
		CreatedAt: f.now(), ExpiresAt: a.ExpiresAt,
	}
	f.rows = append(f.rows, r)
	return r, nil
}

func (f *fakeStore) GetEmailTokenByLinkHash(_ context.Context, h string) (db.AuthEmailToken, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, r := range f.rows {
		if r.LinkTokenHash == h {
			return r, nil
		}
	}
	return db.AuthEmailToken{}, pgx.ErrNoRows
}

func (f *fakeStore) GetLatestUnconsumedEmailTokenForEmail(_ context.Context, email string) (db.AuthEmailToken, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lookups++
	if f.failGet != nil {
		return db.AuthEmailToken{}, f.failGet
	}
	for i := len(f.rows) - 1; i >= 0; i-- {
		if r := f.rows[i]; strings.EqualFold(r.Email, email) && r.ConsumedAt == nil {
			return r, nil
		}
	}
	return db.AuthEmailToken{}, pgx.ErrNoRows
}

func (f *fakeStore) find(id uuid.UUID) *db.AuthEmailToken {
	for i := range f.rows {
		if f.rows[i].ID == id {
			return &f.rows[i]
		}
	}
	return nil
}

func (f *fakeStore) IncrementEmailTokenAttempts(_ context.Context, id uuid.UUID) (int32, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	r := f.find(id)
	if r == nil || !f.live(r) {
		return 0, pgx.ErrNoRows
	}
	r.Attempts++
	return r.Attempts, nil
}

func (f *fakeStore) ConsumeEmailToken(_ context.Context, id uuid.UUID) (db.AuthEmailToken, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	r := f.find(id)
	if r == nil || !f.live(r) {
		return db.AuthEmailToken{}, pgx.ErrNoRows
	}
	now := f.now()
	r.ConsumedAt = &now
	return *r, nil
}

func (f *fakeStore) InvalidateEmailTokensForEmail(_ context.Context, email string) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var n int64
	now := f.now()
	for i := range f.rows {
		if strings.EqualFold(f.rows[i].Email, email) && f.rows[i].ConsumedAt == nil {
			f.rows[i].ConsumedAt = &now
			n++
		}
	}
	return n, nil
}

type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func newTestService() (*Service, *fakeStore, *clock) {
	c := &clock{t: time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)}
	st := &fakeStore{now: c.now}
	return New(st, Options{Now: c.now}), st, c
}

const email = "ada@example.com"

func mustIssue(t *testing.T, s *Service) Issued {
	t.Helper()
	is, err := s.Issue(context.Background(), email, IntentSignIn, IssueOptions{})
	if err != nil {
		t.Fatal(err)
	}
	return is
}

// wrongCode returns a valid code different from code.
func wrongCode(code string) string {
	if code == "000000" {
		return "000001"
	}
	return "000000"
}

func TestIssue(t *testing.T) {
	s, st, c := newTestService()
	ctx := context.Background()
	uid := uuid.New()
	next := "/projects/demo"
	is, err := s.Issue(ctx, "  "+email+" ", IntentSignUp, IssueOptions{UserID: &uid, NextPath: &next, UserAgent: "ua"})
	if err != nil {
		t.Fatal(err)
	}
	if b, err := base64.RawURLEncoding.DecodeString(is.LinkToken); err != nil || len(b) != 32 {
		t.Fatalf("link token %q: %d bytes, %v", is.LinkToken, len(b), err)
	}
	if !regexp.MustCompile(`^[0-9]{6}$`).MatchString(is.Code) {
		t.Fatalf("code %q is not 6 digits", is.Code)
	}
	r := is.Row
	if r.Email != email || r.Intent != "signup" || r.UserID == nil || *r.UserID != uid ||
		r.NextPath == nil || *r.NextPath != next || r.UserAgent != "ua" || !r.ExpiresAt.Equal(c.t.Add(TTL)) {
		t.Fatalf("row: %+v", r)
	}
	if r.LinkTokenHash != hashLink(is.LinkToken) || r.CodeHash != hashCode(r.ID, is.Code) {
		t.Fatal("row must hold the hashes of the secrets")
	}
	if strings.Contains(r.LinkTokenHash+r.CodeHash, is.LinkToken) || r.CodeHash == hashLink(is.Code) {
		t.Fatal("secrets must not be stored in the clear or unsalted")
	}
	if len(st.rows) != 1 {
		t.Fatalf("rows = %d", len(st.rows))
	}

	t.Run("invalid requests", func(t *testing.T) {
		for _, tc := range []struct {
			email  string
			intent Intent
		}{{"", IntentSignIn}, {"   ", IntentSignIn}, {email, "login"}, {email, ""}} {
			if _, err := s.Issue(ctx, tc.email, tc.intent, IssueOptions{}); !errors.Is(err, ErrInvalidRequest) {
				t.Errorf("Issue(%q, %q) = %v, want ErrInvalidRequest", tc.email, tc.intent, err)
			}
		}
	})

	t.Run("store failure rolls back", func(t *testing.T) {
		boom := errors.New("boom")
		st.failTx = boom
		defer func() { st.failTx = nil }()
		if _, err := s.Issue(ctx, email, IntentSignIn, IssueOptions{}); !errors.Is(err, boom) {
			t.Fatalf("want boom, got %v", err)
		}
	})

	t.Run("randomness failure", func(t *testing.T) {
		s2, _, _ := newTestService()
		s2.rand = func() (string, string, error) { return "", "", errors.New("no entropy") }
		if _, err := s2.Issue(ctx, email, IntentSignIn, IssueOptions{}); err == nil {
			t.Fatal("want error")
		}
	})
}

func TestIssueInvalidatesOlder(t *testing.T) {
	s, _, _ := newTestService()
	ctx := context.Background()
	old := mustIssue(t, s)
	fresh := mustIssue(t, s)
	if _, err := s.VerifyLink(ctx, old.LinkToken); !errors.Is(err, ErrInvalidLink) {
		t.Fatalf("old link: %v", err)
	}
	if old.Code != fresh.Code {
		if _, err := s.VerifyCode(ctx, email, old.Code); !errors.Is(err, ErrInvalidCode) {
			t.Fatalf("old code: %v", err)
		}
	}
	if r, err := s.VerifyCode(ctx, email, fresh.Code); err != nil || r.ID != fresh.Row.ID {
		t.Fatalf("fresh code: %+v %v", r, err)
	}
}

func TestLatest(t *testing.T) {
	s, st, c := newTestService()
	ctx := context.Background()
	if _, ok, err := s.Latest(ctx, email); err != nil || ok {
		t.Fatalf("no email: ok = %v, err = %v", ok, err)
	}
	mustIssue(t, s)
	c.t = c.t.Add(time.Minute)
	second := mustIssue(t, s)
	row, ok, err := s.Latest(ctx, " "+email)
	if err != nil || !ok || row.ID != second.Row.ID {
		t.Fatalf("latest = %v %v %v, want the second email", row.ID, ok, err)
	}
	st.failGet = errors.New("boom")
	if _, _, err := s.Latest(ctx, email); err == nil {
		t.Fatal("lookup error not returned")
	}
}

func TestVerifyCode(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name string
		// setup issues (or not) and returns the code to submit.
		setup   func(t *testing.T, s *Service, st *fakeStore, c *clock) string
		email   string
		want    error
		attempt int32 // attempts on the latest row afterwards (-1: no row)
	}{
		{
			name:  "correct code consumes",
			setup: func(t *testing.T, s *Service, _ *fakeStore, _ *clock) string { return mustIssue(t, s).Code },
		},
		{
			name: "correct code typed with separators and other case email",
			setup: func(t *testing.T, s *Service, _ *fakeStore, _ *clock) string {
				c := mustIssue(t, s).Code
				return " " + c[:3] + "-" + c[3:] + " "
			},
			email: "ADA@Example.com",
		},
		{
			name: "wrong code counts an attempt",
			setup: func(t *testing.T, s *Service, _ *fakeStore, _ *clock) string {
				return wrongCode(mustIssue(t, s).Code)
			},
			want: ErrInvalidCode, attempt: 1,
		},
		{
			name: "malformed code counts an attempt",
			setup: func(t *testing.T, s *Service, _ *fakeStore, _ *clock) string {
				mustIssue(t, s)
				return "12345a"
			},
			want: ErrInvalidCode, attempt: 1,
		},
		{
			name:  "no row for the address",
			setup: func(*testing.T, *Service, *fakeStore, *clock) string { return "123456" },
			want:  ErrInvalidCode, attempt: -1,
		},
		{
			name: "code of another address",
			setup: func(t *testing.T, s *Service, _ *fakeStore, _ *clock) string {
				return mustIssue(t, s).Code
			},
			email: "eve@example.com",
			want:  ErrInvalidCode,
		},
		{
			name: "already consumed",
			setup: func(t *testing.T, s *Service, _ *fakeStore, _ *clock) string {
				is := mustIssue(t, s)
				if _, err := s.VerifyLink(context.Background(), is.LinkToken); err != nil {
					t.Fatal(err)
				}
				return is.Code
			},
			want: ErrInvalidCode, attempt: -1,
		},
		{
			name: "expired correct code",
			setup: func(t *testing.T, s *Service, _ *fakeStore, c *clock) string {
				code := mustIssue(t, s).Code
				c.t = c.t.Add(TTL)
				return code
			},
			want: ErrCodeExpired,
		},
		{
			name: "expired wrong code",
			setup: func(t *testing.T, s *Service, _ *fakeStore, c *clock) string {
				code := mustIssue(t, s).Code
				c.t = c.t.Add(TTL + time.Second)
				return wrongCode(code)
			},
			want: ErrInvalidCode,
		},
		{
			name: "fifth wrong guess locks out",
			setup: func(t *testing.T, s *Service, _ *fakeStore, _ *clock) string {
				code := mustIssue(t, s).Code
				for range MaxAttempts - 1 {
					if _, err := s.VerifyCode(context.Background(), email, wrongCode(code)); !errors.Is(err, ErrInvalidCode) {
						t.Fatalf("guess: %v", err)
					}
				}
				return wrongCode(code)
			},
			want: ErrTooManyAttempts, attempt: MaxAttempts,
		},
		{
			name: "correct code after lockout",
			setup: func(t *testing.T, s *Service, _ *fakeStore, _ *clock) string {
				code := mustIssue(t, s).Code
				for range MaxAttempts {
					_, _ = s.VerifyCode(context.Background(), email, wrongCode(code))
				}
				return code
			},
			want: ErrTooManyAttempts, attempt: MaxAttempts,
		},
		{
			name: "consume lost to a concurrent use",
			setup: func(t *testing.T, s *Service, st *fakeStore, _ *clock) string {
				is := mustIssue(t, s)
				st.failGet = nil
				// The lookup sees the row live; it is consumed before ours.
				s.store = &racingStore{fakeStore: st}
				return is.Code
			},
			want: ErrInvalidCode, attempt: -1,
		},
		{
			name: "wrong guess raced by expiry",
			setup: func(t *testing.T, s *Service, st *fakeStore, _ *clock) string {
				is := mustIssue(t, s)
				s.store = &racingStore{fakeStore: st}
				return wrongCode(is.Code)
			},
			want: ErrInvalidCode, attempt: -1,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s, st, c := newTestService()
			code := tc.setup(t, s, st, c)
			addr := tc.email
			if addr == "" {
				addr = email
			}
			row, err := s.VerifyCode(ctx, addr, code)
			if !errors.Is(err, tc.want) {
				t.Fatalf("VerifyCode = %v, want %v", err, tc.want)
			}
			if tc.want == nil && (row.ConsumedAt == nil || row.Email != email) {
				t.Fatalf("success must return the consumed row: %+v", row)
			}
			if tc.want != nil && row.ID != uuid.Nil {
				t.Fatalf("failure must return no row: %+v", row)
			}
			latest, err := st.GetLatestUnconsumedEmailTokenForEmail(ctx, email)
			switch {
			case tc.want == nil || tc.attempt == -1:
				if !errors.Is(err, pgx.ErrNoRows) && tc.want == nil {
					t.Fatalf("row must be consumed: %+v %v", latest, err)
				}
			case err != nil:
				t.Fatalf("latest: %v", err)
			case latest.Attempts != tc.attempt:
				t.Fatalf("attempts = %d, want %d", latest.Attempts, tc.attempt)
			}
		})
	}

	t.Run("lookup failure", func(t *testing.T) {
		s, st, _ := newTestService()
		boom := errors.New("boom")
		st.failGet = boom
		if _, err := s.VerifyCode(ctx, email, "123456"); !errors.Is(err, boom) {
			t.Fatalf("want boom, got %v", err)
		}
	})

	t.Run("single use", func(t *testing.T) {
		s, _, _ := newTestService()
		is := mustIssue(t, s)
		if _, err := s.VerifyCode(ctx, email, is.Code); err != nil {
			t.Fatal(err)
		}
		if _, err := s.VerifyCode(ctx, email, is.Code); !errors.Is(err, ErrInvalidCode) {
			t.Fatalf("second use: %v", err)
		}
		if _, err := s.VerifyLink(ctx, is.LinkToken); !errors.Is(err, ErrInvalidLink) {
			t.Fatalf("link after code: %v", err)
		}
	})

	t.Run("compare runs even without a row", func(t *testing.T) {
		s, st, _ := newTestService()
		// No row: the lookup still happens and the dummy hash is compared.
		if _, err := s.VerifyCode(ctx, "nobody@example.com", "123456"); !errors.Is(err, ErrInvalidCode) {
			t.Fatal(err)
		}
		if st.lookups != 1 {
			t.Fatalf("lookups = %d", st.lookups)
		}
		if len(dummyCodeHash) != len(hashCode(uuid.New(), "123456")) {
			t.Fatal("dummy hash must have the length of a real hash so the compare does full work")
		}
	})
}

// racingStore simulates another request using or expiring the row between
// the lookup and the write.
type racingStore struct{ *fakeStore }

func (r *racingStore) IncrementEmailTokenAttempts(context.Context, uuid.UUID) (int32, error) {
	return 0, pgx.ErrNoRows
}

func (r *racingStore) ConsumeEmailToken(context.Context, uuid.UUID) (db.AuthEmailToken, error) {
	return db.AuthEmailToken{}, pgx.ErrNoRows
}

func TestVerifyLink(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name  string
		setup func(t *testing.T, s *Service, st *fakeStore, c *clock) string
		want  error
	}{
		{
			name:  "live link consumes",
			setup: func(t *testing.T, s *Service, _ *fakeStore, _ *clock) string { return mustIssue(t, s).LinkToken },
		},
		{
			name: "works after wrong code guesses",
			setup: func(t *testing.T, s *Service, _ *fakeStore, _ *clock) string {
				is := mustIssue(t, s)
				for range MaxAttempts {
					_, _ = s.VerifyCode(context.Background(), email, wrongCode(is.Code))
				}
				return is.LinkToken
			},
		},
		{
			name:  "malformed: empty",
			setup: func(*testing.T, *Service, *fakeStore, *clock) string { return "" },
			want:  ErrInvalidLink,
		},
		{
			name: "malformed: padded",
			setup: func(t *testing.T, s *Service, _ *fakeStore, _ *clock) string {
				return mustIssue(t, s).LinkToken + "="
			},
			want: ErrInvalidLink,
		},
		{
			name:  "malformed: bad alphabet",
			setup: func(*testing.T, *Service, *fakeStore, *clock) string { return strings.Repeat("+", 43) },
			want:  ErrInvalidLink,
		},
		{
			name: "unknown",
			setup: func(*testing.T, *Service, *fakeStore, *clock) string {
				return base64.RawURLEncoding.EncodeToString(make([]byte, 32))
			},
			want: ErrInvalidLink,
		},
		{
			name: "reused",
			setup: func(t *testing.T, s *Service, _ *fakeStore, _ *clock) string {
				is := mustIssue(t, s)
				if _, err := s.VerifyLink(context.Background(), is.LinkToken); err != nil {
					t.Fatal(err)
				}
				return is.LinkToken
			},
			want: ErrInvalidLink,
		},
		{
			name: "used by its code",
			setup: func(t *testing.T, s *Service, _ *fakeStore, _ *clock) string {
				is := mustIssue(t, s)
				if _, err := s.VerifyCode(context.Background(), email, is.Code); err != nil {
					t.Fatal(err)
				}
				return is.LinkToken
			},
			want: ErrInvalidLink,
		},
		{
			name: "expired",
			setup: func(t *testing.T, s *Service, _ *fakeStore, c *clock) string {
				link := mustIssue(t, s).LinkToken
				c.t = c.t.Add(TTL)
				return link
			},
			want: ErrLinkExpired,
		},
		{
			name: "consume lost to a concurrent use",
			setup: func(t *testing.T, s *Service, st *fakeStore, _ *clock) string {
				link := mustIssue(t, s).LinkToken
				s.store = &racingStore{fakeStore: st}
				return link
			},
			want: ErrInvalidLink,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s, st, c := newTestService()
			raw := tc.setup(t, s, st, c)
			row, err := s.VerifyLink(ctx, raw)
			if !errors.Is(err, tc.want) {
				t.Fatalf("VerifyLink = %v, want %v", err, tc.want)
			}
			if tc.want == nil && (row.ConsumedAt == nil || row.LinkTokenHash != hashLink(raw)) {
				t.Fatalf("success must return the consumed row: %+v", row)
			}
		})
	}
}

func TestParseCode(t *testing.T) {
	for _, tc := range []struct {
		in, want string
		ok       bool
	}{
		{"012345", "012345", true},
		{"000000", "000000", true},
		{" 123 456 ", "123456", true},
		{"123-456", "123456", true},
		{"\t123456", "123456", true},
		{"", "", false},
		{"12345", "", false},
		{"1234567", "", false},
		{"12345a", "", false},
		{"١٢٣٤٥٦", "", false}, // non-ASCII digits
		{"123456\n", "", false},
		{"+12345", "", false},
		{strings.Repeat(" ", 100) + "123456", "", false},
	} {
		got, err := ParseCode(tc.in)
		if (err == nil) != tc.ok || got != tc.want {
			t.Errorf("ParseCode(%q) = %q, %v; want %q ok=%v", tc.in, got, err, tc.want, tc.ok)
		}
		if err != nil && !errors.Is(err, ErrInvalidCode) {
			t.Errorf("ParseCode(%q) error %v is not ErrInvalidCode", tc.in, err)
		}
	}
}

func FuzzParseCode(f *testing.F) {
	for _, s := range []string{"123456", "000000", "123 456", "123-456", "", "12345a", "1234567", "١٢٣٤٥٦", "\x00"} {
		f.Add(s)
	}
	digits := regexp.MustCompile(`^[0-9]{6}$`)
	f.Fuzz(func(t *testing.T, in string) {
		got, err := ParseCode(in)
		if err != nil {
			if got != "" || !errors.Is(err, ErrInvalidCode) {
				t.Fatalf("ParseCode(%q) = %q, %v", in, got, err)
			}
			return
		}
		if !digits.MatchString(got) {
			t.Fatalf("ParseCode(%q) = %q: not 6 ASCII digits", in, got)
		}
		// Normalisation keeps the input's digits in order and is idempotent.
		var kept strings.Builder
		for _, r := range in {
			if r >= '0' && r <= '9' {
				kept.WriteRune(r)
			}
		}
		if kept.String() != got {
			t.Fatalf("ParseCode(%q) = %q, want the input's digits %q", in, got, kept.String())
		}
		if again, err := ParseCode(got); err != nil || again != got {
			t.Fatalf("ParseCode not idempotent on %q: %q, %v", got, again, err)
		}
	})
}

func TestNewSecrets(t *testing.T) {
	seen := map[string]bool{}
	lead := 0
	for range 2000 {
		link, code, err := newSecrets()
		if err != nil {
			t.Fatal(err)
		}
		if !validLinkToken(link) || seen[link] {
			t.Fatalf("link token %q invalid or repeated", link)
		}
		seen[link] = true
		if _, err := ParseCode(code); err != nil || len(code) != CodeLength {
			t.Fatalf("code %q", code)
		}
		if code[0] == '0' {
			lead++
		}
	}
	// A uniform draw starts with 0 one time in ten; 2000 draws make zero
	// leading zeros astronomically unlikely unless they are being dropped.
	if lead == 0 {
		t.Fatal("no code started with 0: leading zeros are being lost")
	}
}
