//go:build integration

package identity

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/identity/audit"
	signingkeys "github.com/apilens/apilens/internal/identity/keys"
	"github.com/apilens/apilens/internal/identity/session"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/identity/token"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/testutil"
)

type itestKeys []signingkeys.Key

func (s itestKeys) Active() (signingkeys.Key, bool) { return signingkeys.Active(s) }
func (s itestKeys) All() []signingkeys.Key          { return s }

// TestListMySessions runs GET /api/v1/users/me/sessions end to end: real
// sessions in Postgres, access tokens from the real issuer verified by
// authn.Middleware.
func TestListMySessions(t *testing.T) {
	const issuerURL = "https://id.example.com"
	pool := testutil.MigratedPostgres(t)
	q := db.New(pool)
	logger := testutil.Logger(t)

	priv, err := rsa.GenerateKey(rand.Reader, signingkeys.MinRSABits)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	k, err := signingkeys.Unstored(priv, &now, nil)
	if err != nil {
		t.Fatal(err)
	}
	issuer, err := token.New(itestKeys{k}, token.Options{Issuer: issuerURL, TTL: 15 * time.Minute})
	if err != nil {
		t.Fatal(err)
	}
	svc, err := session.New(pool, issuer, session.Options{RefreshTTL: 720 * time.Hour, RefreshTTLShort: 24 * time.Hour}, logger)
	if err != nil {
		t.Fatal(err)
	}
	limiter, err := ratelimit.New(nil, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	src := authn.KeySourceFunc(func(_ context.Context, kid string) (crypto.PublicKey, error) {
		if kid != k.KID {
			return nil, authn.ErrUnknownKey
		}
		return k.Signer().Public(), nil
	})
	_, api := humatest.New(t)
	api.UseMiddleware(authn.Middleware(api, authn.NewSessionVerifier(src, issuerURL, nil)))
	NewSessions(config.IdentityConfig{}, svc, limiter, logger).Register(api)

	ctx := context.Background()
	user, err := q.CreateUser(ctx, db.CreateUserParams{ID: uuid.New(), Email: "ada@example.com", Name: "Ada"})
	if err != nil {
		t.Fatal(err)
	}
	other, err := q.CreateUser(ctx, db.CreateUserParams{ID: uuid.New(), Email: "bob@example.com", Name: "Bob"})
	if err != nil {
		t.Fatal(err)
	}
	signIn := func(u db.User, ua string) session.Tokens {
		t.Helper()
		rctx := audit.WithRequest(ctx, audit.Request{IP: netip.MustParseAddr("203.0.113.7"), UserAgent: ua})
		tok, err := svc.Create(rctx, u, true, session.Meta{AMR: []string{token.AMREmail}})
		if err != nil {
			t.Fatal(err)
		}
		return tok
	}
	type item struct {
		ID          string    `json:"id"`
		DeviceLabel string    `json:"device_label"`
		UserAgent   string    `json:"user_agent"`
		IP          *string   `json:"ip"`
		AMR         []string  `json:"amr"`
		CreatedAt   time.Time `json:"created_at"`
		LastSeenAt  time.Time `json:"last_seen_at"`
		Current     bool      `json:"current"`
	}
	list := func(access string) []item {
		t.Helper()
		resp := api.Get(MySessionsPath, "Authorization: Bearer "+access)
		if resp.Code != http.StatusOK {
			t.Fatalf("status = %d: %s", resp.Code, resp.Body)
		}
		var body struct {
			Sessions []item `json:"sessions"`
		}
		if err := json.Unmarshal(resp.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return body.Sessions
	}

	chromeMac := "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
	// A user agent padded far beyond the limit is stored truncated.
	firefoxWin := "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0 " + strings.Repeat("x", 2000)
	laptop := signIn(user, chromeMac)
	phone := signIn(user, firefoxWin)
	theirs := signIn(other, "curl/8.4.0")

	t.Run("lists live sessions with the caller's flagged", func(t *testing.T) {
		got := list(laptop.AccessToken)
		if len(got) != 2 {
			t.Fatalf("sessions = %+v", got)
		}
		// Most recently active first: phone signed in after laptop.
		if got[0].ID != phone.Session.ID.String() || got[1].ID != laptop.Session.ID.String() {
			t.Fatalf("order = %s, %s", got[0].ID, got[1].ID)
		}
		if got[0].Current || !got[1].Current {
			t.Fatalf("current flags = %v, %v; want the laptop's", got[0].Current, got[1].Current)
		}
		if got[1].DeviceLabel != "Chrome on macOS" || got[1].UserAgent != chromeMac ||
			got[1].IP == nil || *got[1].IP != "203.0.113.7" || len(got[1].AMR) != 1 || got[1].CreatedAt.IsZero() {
			t.Fatalf("laptop = %+v", got[1])
		}
		if got[0].DeviceLabel != "Firefox on Windows" || len(got[0].UserAgent) != session.MaxUserAgentLen ||
			!strings.HasPrefix(firefoxWin, got[0].UserAgent) {
			t.Fatalf("phone label %q, user agent %d bytes", got[0].DeviceLabel, len(got[0].UserAgent))
		}
		for _, s := range got {
			if s.ID == theirs.Session.ID.String() {
				t.Fatal("another user's session is listed")
			}
		}
	})

	t.Run("flag follows the family across a refresh", func(t *testing.T) {
		rotated, err := svc.Refresh(ctx, phone.RefreshToken)
		if err != nil {
			t.Fatal(err)
		}
		// The old access token's sid names the rotated parent row.
		got := list(phone.AccessToken)
		if len(got) != 2 || got[0].ID != rotated.Session.ID.String() || !got[0].Current || got[1].Current {
			t.Fatalf("sessions = %+v", got)
		}
		got = list(rotated.AccessToken)
		if !got[0].Current || got[1].Current {
			t.Fatalf("with the new token: %+v", got)
		}
	})

	t.Run("ended sessions are not listed", func(t *testing.T) {
		if err := svc.Logout(ctx, laptop.RefreshToken); err != nil {
			t.Fatal(err)
		}
		// The laptop's access token is still valid until it expires; its
		// session is gone from the list and nothing is current.
		got := list(laptop.AccessToken)
		if len(got) != 1 || got[0].Current {
			t.Fatalf("sessions = %+v", got)
		}
	})

	t.Run("requires a session", func(t *testing.T) {
		if resp := api.Get(MySessionsPath); resp.Code != http.StatusUnauthorized {
			t.Fatalf("no token: status = %d", resp.Code)
		}
		if resp := api.Get(MySessionsPath, "Authorization: Bearer a.b.c"); resp.Code != http.StatusUnauthorized {
			t.Fatalf("bad token: status = %d", resp.Code)
		}
	})
}
