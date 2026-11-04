//go:build integration

package ratelimit

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/apilens/apilens/internal/platform/cache"
	"github.com/apilens/apilens/internal/testutil"
)

func newValkeyLimiter(t *testing.T) *Limiter {
	t.Helper()
	client, err := cache.Connect(context.Background(), testutil.Valkey(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.Close)
	l, err := New(client, testutil.Logger(t), nil)
	if err != nil {
		t.Fatal(err)
	}
	return l
}

func TestValkeyLimits(t *testing.T) {
	l := newValkeyLimiter(t)

	t.Run("per IP: 429 with Retry-After once the window is full", func(t *testing.T) {
		api := newTestAPI(t, l, Rate{Limit: 3, Window: time.Minute}, Key{})
		for i := range 3 {
			resp := api.Get("/limited")
			if resp.Code != http.StatusNoContent {
				t.Fatalf("request %d: status = %d, want 204", i+1, resp.Code)
			}
		}
		resp := api.Get("/limited")
		if resp.Code != http.StatusTooManyRequests {
			t.Fatalf("status = %d, want 429", resp.Code)
		}
		secs, err := strconv.Atoi(resp.Header().Get("Retry-After"))
		if err != nil || secs < 1 || secs > 60 {
			t.Fatalf("Retry-After = %q, want 1..60 seconds", resp.Header().Get("Retry-After"))
		}
	})

	t.Run("per key: subjects get separate, normalized buckets", func(t *testing.T) {
		var mu sync.Mutex
		subject := "Alice@Example.com"
		from := func(huma.Context) string { mu.Lock(); defer mu.Unlock(); return subject }
		setSubject := func(s string) { mu.Lock(); defer mu.Unlock(); subject = s }
		api := newTestAPI(t, l, Rate{}, Key{Rate: Rate{Limit: 2, Window: time.Minute}, From: from})

		for range 2 {
			if resp := api.Get("/limited"); resp.Code != http.StatusNoContent {
				t.Fatalf("status = %d, want 204", resp.Code)
			}
		}
		setSubject("  alice@example.com ")
		if resp := api.Get("/limited"); resp.Code != http.StatusTooManyRequests {
			t.Fatalf("normalized subject: status = %d, want 429", resp.Code)
		}
		setSubject("bob@example.com")
		if resp := api.Get("/limited"); resp.Code != http.StatusNoContent {
			t.Fatalf("other subject: status = %d, want 204", resp.Code)
		}
	})

	t.Run("window slides: admitted again after it passes", func(t *testing.T) {
		r := Rate{Limit: 2, Window: time.Second}
		ctx := context.Background()
		for range 2 {
			if res, err := l.Allow(ctx, "slide", "k", r); err != nil || !res.Allowed {
				t.Fatalf("Allow = %+v, %v", res, err)
			}
		}
		res, err := l.Allow(ctx, "slide", "k", r)
		if err != nil || res.Allowed {
			t.Fatalf("over limit: Allow = %+v, %v", res, err)
		}
		if res.RetryAfter <= 0 || res.RetryAfter > time.Second {
			t.Fatalf("RetryAfter = %v, want (0, 1s]", res.RetryAfter)
		}
		time.Sleep(res.RetryAfter + 50*time.Millisecond)
		if res, err := l.Allow(ctx, "slide", "k", r); err != nil || !res.Allowed {
			t.Fatalf("after window: Allow = %+v, %v (want allowed)", res, err)
		}
	})

	t.Run("Check returns a 429 carrying Retry-After", func(t *testing.T) {
		r := Rate{Limit: 1, Window: time.Minute}
		ctx := context.Background()
		if err := l.Check(ctx, "check", "carol@example.com", r); err != nil {
			t.Fatal(err)
		}
		err := l.Check(ctx, "check", "carol@example.com", r)
		var se huma.StatusError
		var he huma.HeadersError
		if !errors.As(err, &se) || se.GetStatus() != http.StatusTooManyRequests {
			t.Fatalf("err = %v, want 429", err)
		}
		if !errors.As(err, &he) || he.GetHeaders().Get("Retry-After") == "" {
			t.Fatalf("err = %v, want a Retry-After header", err)
		}
	})

	t.Run("concurrent requests never exceed the limit", func(t *testing.T) {
		r := Rate{Limit: 10, Window: time.Minute}
		var wg sync.WaitGroup
		var mu sync.Mutex
		allowed := 0
		for range 50 {
			wg.Go(func() {
				res, err := l.Allow(context.Background(), "race", "k", r)
				if err != nil {
					t.Error(err)
					return
				}
				if res.Allowed {
					mu.Lock()
					allowed++
					mu.Unlock()
				}
			})
		}
		wg.Wait()
		if allowed != r.Limit {
			t.Fatalf("allowed = %d, want %d", allowed, r.Limit)
		}
	})
}

func TestValkeyDownFailsClosed(t *testing.T) {
	client, err := cache.Connect(context.Background(), testutil.Valkey(t))
	if err != nil {
		t.Fatal(err)
	}
	l, err := New(client, slog.New(slog.DiscardHandler), nil)
	if err != nil {
		t.Fatal(err)
	}
	api := newTestAPI(t, l, Rate{Limit: 5, Window: time.Minute}, Key{})
	if resp := api.Get("/limited"); resp.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", resp.Code)
	}
	client.Close()
	if resp := api.Get("/limited"); resp.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 once valkey is gone", resp.Code)
	}
	if _, err := l.Allow(context.Background(), "x", "k", Rate{Limit: 1, Window: time.Minute}); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err = %v, want ErrUnavailable", err)
	}
}
