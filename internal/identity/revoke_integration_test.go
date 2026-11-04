//go:build integration

package identity

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/google/uuid"

	signingkeys "github.com/apilens/apilens/internal/identity/keys"
	"github.com/apilens/apilens/internal/identity/session"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/identity/token"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/cache"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/testutil"
)

// lockedBuffer is a goroutine-safe log sink.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// TestRevokedAccessTokenDenied runs the revocation endpoints end to end:
// identity revokes sessions in Postgres and pushes their sids into a Valkey
// denylist; a verifier in another process (its own Denylist and local
// cache) refuses their access tokens within authn.DenylistCacheTTL.
func TestRevokedAccessTokenDenied(t *testing.T) {
	const (
		issuerURL = "https://id.example.com"
		accessTTL = 15 * time.Minute
	)
	pool := testutil.MigratedPostgres(t)
	q := db.New(pool)
	logger := testutil.Logger(t)
	ctx := context.Background()

	vk, err := cache.Connect(ctx, testutil.Valkey(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(vk.Close)

	priv, err := rsa.GenerateKey(rand.Reader, signingkeys.MinRSABits)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	k, err := signingkeys.Unstored(priv, &now, nil)
	if err != nil {
		t.Fatal(err)
	}
	issuer, err := token.New(itestKeys{k}, token.Options{Issuer: issuerURL, TTL: accessTTL})
	if err != nil {
		t.Fatal(err)
	}
	src := authn.KeySourceFunc(func(_ context.Context, kid string) (crypto.PublicKey, error) {
		if kid != k.KID {
			return nil, authn.ErrUnknownKey
		}
		return k.Signer().Public(), nil
	})

	// The identity process.
	idDeny := authn.NewDenylist(vk, accessTTL, logger)
	svc, err := session.New(pool, issuer, session.Options{
		RefreshTTL: 720 * time.Hour, RefreshTTLShort: 24 * time.Hour,
		AccessTTL: accessTTL, Denylist: idDeny,
	}, logger)
	if err != nil {
		t.Fatal(err)
	}
	limiter, err := ratelimit.New(nil, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, idAPI := humatest.New(t)
	idAPI.UseMiddleware(authn.Middleware(idAPI, authn.NewSessionVerifier(src, issuerURL, nil).WithDenylist(idDeny)))
	NewSessions(config.IdentityConfig{}, svc, limiter, logger).Register(idAPI)

	// Another process (an api replica) with its own denylist cache.
	newProbe := func(t *testing.T, d *authn.Denylist) humatest.TestAPI {
		t.Helper()
		_, api := humatest.New(t)
		api.UseMiddleware(authn.Middleware(api, authn.NewSessionVerifier(src, issuerURL, nil).WithDenylist(d)))
		huma.Register(api, huma.Operation{OperationID: "probe", Method: http.MethodGet, Path: "/probe", DefaultStatus: http.StatusOK,
			Security: []map[string][]string{{authn.SchemeSession: {}}}}, func(context.Context, *struct{}) (*struct{}, error) { return nil, nil })
		return api
	}
	probe := newProbe(t, authn.NewDenylist(vk, accessTTL, logger))
	status := func(api humatest.TestAPI, access string) int {
		return api.Get("/probe", "Authorization: Bearer "+access).Code
	}
	// deniedWithin waits until the probe refuses access and returns how long
	// that took.
	deniedWithin := func(t *testing.T, access string) time.Duration {
		t.Helper()
		start := time.Now()
		deadline := start.Add(authn.DenylistCacheTTL + 2*time.Second)
		for time.Now().Before(deadline) {
			if code := status(probe, access); code == http.StatusUnauthorized {
				return time.Since(start)
			}
			time.Sleep(100 * time.Millisecond)
		}
		t.Fatalf("access token still accepted %v after revocation", time.Since(start))
		return 0
	}

	newUser := func(t *testing.T) db.User {
		t.Helper()
		u, err := q.CreateUser(ctx, db.CreateUserParams{ID: uuid.New(), Email: uuid.NewString() + "@example.com"})
		if err != nil {
			t.Fatal(err)
		}
		return u
	}
	signIn := func(t *testing.T, u db.User) session.Tokens {
		t.Helper()
		tok, err := svc.Create(ctx, u, true, session.Meta{AMR: []string{token.AMREmail}})
		if err != nil {
			t.Fatal(err)
		}
		// Prime the probe's local cache with "not denied", the worst case.
		if code := status(probe, tok.AccessToken); code != http.StatusOK {
			t.Fatalf("fresh token: status = %d", code)
		}
		return tok
	}
	bearer := func(tok session.Tokens) string { return "Authorization: Bearer " + tok.AccessToken }

	t.Run("revoke one session", func(t *testing.T) {
		u := newUser(t)
		laptop, phone := signIn(t, u), signIn(t, u)
		resp := idAPI.Delete(MySessionsPath+"/"+laptop.Session.ID.String(), bearer(phone))
		if resp.Code != http.StatusNoContent {
			t.Fatalf("status = %d: %s", resp.Code, resp.Body)
		}
		if d := deniedWithin(t, laptop.AccessToken); d > authn.DenylistCacheTTL+time.Second {
			t.Fatalf("denied after %v", d)
		}
		// The revoking process refuses it at once; the phone still works.
		if resp := idAPI.Get(MySessionsPath, bearer(laptop)); resp.Code != http.StatusUnauthorized {
			t.Fatalf("identity: revoked token status = %d", resp.Code)
		}
		if code := status(probe, phone.AccessToken); code != http.StatusOK {
			t.Fatalf("other session: status = %d", code)
		}
	})

	t.Run("revoke others", func(t *testing.T) {
		u := newUser(t)
		current, a, b := signIn(t, u), signIn(t, u), signIn(t, u)
		resp := idAPI.Post(MySessionsPath+"/revoke-others", bearer(current))
		if resp.Code != http.StatusOK || !strings.Contains(resp.Body.String(), `"revoked":2`) {
			t.Fatalf("status = %d: %s", resp.Code, resp.Body)
		}
		deniedWithin(t, a.AccessToken)
		deniedWithin(t, b.AccessToken)
		if code := status(probe, current.AccessToken); code != http.StatusOK {
			t.Fatalf("current session: status = %d", code)
		}
	})

	t.Run("logout everywhere", func(t *testing.T) {
		u := newUser(t)
		a := signIn(t, u)
		// A refresh leaves the old access token valid until it expires; it
		// is denylisted with the family.
		b := signIn(t, u)
		rotated, err := svc.Refresh(ctx, b.RefreshToken)
		if err != nil {
			t.Fatal(err)
		}
		if code := status(probe, rotated.AccessToken); code != http.StatusOK {
			t.Fatalf("rotated token: status = %d", code)
		}
		resp := idAPI.Post(AuthPrefix+"/logout-all", bearer(a))
		if resp.Code != http.StatusNoContent {
			t.Fatalf("status = %d: %s", resp.Code, resp.Body)
		}
		for _, access := range []string{a.AccessToken, b.AccessToken, rotated.AccessToken} {
			deniedWithin(t, access)
		}
	})

	t.Run("degrades to TTL-only when valkey is down", func(t *testing.T) {
		dead, err := cache.Connect(ctx, testutil.Valkey(t))
		if err != nil {
			t.Fatal(err)
		}
		dead.Close()
		logs := &lockedBuffer{}
		d := authn.NewDenylist(dead, accessTTL, slog.New(slog.NewJSONHandler(logs, nil)))
		down := newProbe(t, d)

		u := newUser(t)
		tok := signIn(t, u)
		// Revoked through the healthy Valkey; this replica cannot see it.
		if _, err := svc.LogoutAll(ctx, u.ID); err != nil {
			t.Fatal(err)
		}
		if code := status(down, tok.AccessToken); code != http.StatusOK {
			t.Fatalf("valkey down: status = %d, want 200 (TTL-only)", code)
		}
		if !strings.Contains(logs.String(), "TTL-only") {
			t.Fatalf("degradation not logged: %q", logs)
		}
		if err := d.Deny(ctx, uuid.New()); err == nil {
			t.Fatal("Deny with Valkey down: want an error")
		}
	})
}
