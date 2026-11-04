package authn

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/google/uuid"
)

func TestDenylistWithoutValkey(t *testing.T) {
	ctx := context.Background()
	d := NewDenylist(nil, 15*time.Minute, slog.New(slog.DiscardHandler))
	sid, other := uuid.New(), uuid.New()
	if d.Denied(ctx, sid) {
		t.Fatal("denied before Deny")
	}
	if err := d.Deny(ctx, sid); err != nil {
		t.Fatal(err)
	}
	// Revocations made in this process apply at once, also without Valkey.
	if !d.Denied(ctx, sid) || d.Denied(ctx, other) {
		t.Fatalf("denied: sid %t, other %t", d.Denied(ctx, sid), d.Denied(ctx, other))
	}

	var none *Denylist
	if none.Denied(ctx, sid) || none.Deny(ctx, sid) != nil {
		t.Fatal("a nil denylist denies nothing")
	}
}

func TestVerifyDenylisted(t *testing.T) {
	k := newSigningKey(t, "k1")
	srv := newJWKSServer(t, k)
	clk := newClock()
	v, _ := newVerifier(srv, clk)
	d := NewDenylist(nil, 15*time.Minute, slog.New(slog.DiscardHandler))
	v.WithDenylist(d)
	ctx := context.Background()

	sid := uuid.New()
	raw := sign(t, k, clk.Now(), func(o *tokenOpts) { o.sid = sid.String() })
	if _, err := v.Verify(ctx, raw); err != nil {
		t.Fatalf("before revocation: %v", err)
	}
	if err := d.Deny(ctx, sid); err != nil {
		t.Fatal(err)
	}
	_, err := v.Verify(ctx, raw)
	if !errors.Is(err, ErrRevoked) || !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("after revocation: err = %v, want ErrRevoked", err)
	}
	// Other sessions are unaffected.
	if _, err := v.Verify(ctx, sign(t, k, clk.Now(), nil)); err != nil {
		t.Fatalf("other session: %v", err)
	}

	_, api := humatest.New(t)
	api.UseMiddleware(Middleware(api, v))
	huma.Register(api, huma.Operation{OperationID: "me", Method: http.MethodGet, Path: "/me",
		Security: []map[string][]string{{SchemeSession: {}}}}, func(context.Context, *struct{}) (*struct{}, error) { return nil, nil })
	res := api.Get("/me", "Authorization: Bearer "+raw).Result()
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusUnauthorized || !strings.Contains(res.Header.Get("WWW-Authenticate"), "session revoked") {
		t.Fatalf("status = %d, WWW-Authenticate %q", res.StatusCode, res.Header.Get("WWW-Authenticate"))
	}
}
