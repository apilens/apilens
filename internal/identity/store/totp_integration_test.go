//go:build integration

package store_test

import (
	"bytes"
	"context"
	"errors"
	"net/netip"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/testutil"
)

func TestTOTP(t *testing.T) {
	ctx := context.Background()
	q := db.New(testutil.MigratedPostgres(t))

	ada, err := q.CreateUser(ctx, db.CreateUserParams{ID: uuid.New(), Email: "ada@example.com"})
	if err != nil {
		t.Fatal(err)
	}

	if _, err := q.GetTOTPForUser(ctx, ada.ID); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("no secret yet: want ErrNoRows, got %v", err)
	}
	if _, err := q.ConfirmTOTP(ctx, ada.ID); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("confirm without a secret: want ErrNoRows, got %v", err)
	}

	pending, err := q.UpsertPendingTOTP(ctx, db.UpsertPendingTOTPParams{UserID: ada.ID, SecretEnc: []byte("ct-1")})
	if err != nil || pending.ConfirmedAt != nil || !bytes.Equal(pending.SecretEnc, []byte("ct-1")) || pending.CreatedAt.IsZero() {
		t.Fatalf("pending: %+v %v", pending, err)
	}
	replaced, err := q.UpsertPendingTOTP(ctx, db.UpsertPendingTOTPParams{UserID: ada.ID, SecretEnc: []byte("ct-2")})
	if err != nil || !bytes.Equal(replaced.SecretEnc, []byte("ct-2")) || replaced.ConfirmedAt != nil {
		t.Fatalf("a pending secret should be replaced: %+v %v", replaced, err)
	}

	confirmed, err := q.ConfirmTOTP(ctx, ada.ID)
	if err != nil || confirmed.ConfirmedAt == nil || !bytes.Equal(confirmed.SecretEnc, []byte("ct-2")) {
		t.Fatalf("confirm: %+v %v", confirmed, err)
	}
	if _, err := q.ConfirmTOTP(ctx, ada.ID); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("second confirm: want ErrNoRows, got %v", err)
	}
	if _, err := q.UpsertPendingTOTP(ctx, db.UpsertPendingTOTPParams{UserID: ada.ID, SecretEnc: []byte("ct-3")}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("re-enable when confirmed: want ErrNoRows, got %v", err)
	}
	got, err := q.GetTOTPForUser(ctx, ada.ID)
	if err != nil || !bytes.Equal(got.SecretEnc, []byte("ct-2")) || got.ConfirmedAt == nil {
		t.Fatalf("confirmed secret must be kept: %+v %v", got, err)
	}

	if n, err := q.DeleteTOTP(ctx, ada.ID); err != nil || n != 1 {
		t.Fatalf("delete = %d, %v; want 1", n, err)
	}
	if n, err := q.DeleteTOTP(ctx, ada.ID); err != nil || n != 0 {
		t.Fatalf("second delete = %d, %v; want 0", n, err)
	}
}

func TestBackupCodes(t *testing.T) {
	ctx := context.Background()
	q := db.New(testutil.MigratedPostgres(t))

	ada, err := q.CreateUser(ctx, db.CreateUserParams{ID: uuid.New(), Email: "ada@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	bob, err := q.CreateUser(ctx, db.CreateUserParams{ID: uuid.New(), Email: "bob@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	create := func(user uuid.UUID, hashes ...string) int64 {
		t.Helper()
		ids := make([]uuid.UUID, len(hashes))
		for i := range ids {
			ids[i] = uuid.New()
		}
		n, err := q.CreateBackupCodes(ctx, db.CreateBackupCodesParams{Ids: ids, UserID: user, CodeHashes: hashes})
		if err != nil {
			t.Fatal(err)
		}
		return n
	}
	count := func(user uuid.UUID) int64 {
		t.Helper()
		n, err := q.CountUnusedBackupCodesForUser(ctx, user)
		if err != nil {
			t.Fatal(err)
		}
		return n
	}

	if n := create(ada.ID, "a1", "a2", "a3"); n != 3 {
		t.Fatalf("created %d codes; want 3", n)
	}
	create(bob.ID, "a1")
	if n := count(ada.ID); n != 3 {
		t.Fatalf("unused = %d; want 3", n)
	}

	used, err := q.UseBackupCode(ctx, db.UseBackupCodeParams{UserID: ada.ID, CodeHash: "a2"})
	if err != nil || used.UsedAt == nil || used.UserID != ada.ID {
		t.Fatalf("use: %+v %v", used, err)
	}
	if _, err := q.UseBackupCode(ctx, db.UseBackupCodeParams{UserID: ada.ID, CodeHash: "a2"}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("reuse: want ErrNoRows, got %v", err)
	}
	if _, err := q.UseBackupCode(ctx, db.UseBackupCodeParams{UserID: ada.ID, CodeHash: "nope"}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("wrong code: want ErrNoRows, got %v", err)
	}
	if n := count(ada.ID); n != 2 {
		t.Fatalf("unused after one use = %d; want 2", n)
	}
	if n := count(bob.ID); n != 1 {
		t.Fatalf("another user's codes must be untouched: %d", n)
	}

	// Regenerate: delete all (used and unused), then a new set.
	if n, err := q.DeleteBackupCodesForUser(ctx, ada.ID); err != nil || n != 3 {
		t.Fatalf("delete = %d, %v; want 3", n, err)
	}
	create(ada.ID, "b1", "b2")
	if _, err := q.UseBackupCode(ctx, db.UseBackupCodeParams{UserID: ada.ID, CodeHash: "a1"}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("an old code after regenerate: want ErrNoRows, got %v", err)
	}
	if n := count(ada.ID); n != 2 {
		t.Fatalf("unused after regenerate = %d; want 2", n)
	}
}

func TestRecoveryRequests(t *testing.T) {
	ctx := context.Background()
	q := db.New(testutil.MigratedPostgres(t))

	ada, err := q.CreateUser(ctx, db.CreateUserParams{ID: uuid.New(), Email: "ada@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Microsecond)
	const delay = 24 * time.Hour
	ip := netip.MustParseAddr("203.0.113.7")
	create := func(token string, at time.Time) db.RecoveryRequest {
		t.Helper()
		r, err := q.CreateRecoveryRequest(ctx, db.CreateRecoveryRequestParams{
			ID: uuid.New(), UserID: ada.ID, TokenHash: token, RequestedAt: at, ReadyAt: at.Add(delay),
			Ip: &ip, UserAgent: "test",
		})
		if err != nil {
			t.Fatal(err)
		}
		return r
	}

	first := create("tok-1", now)
	if !first.RequestedAt.Equal(now) || !first.ReadyAt.Equal(now.Add(delay)) || first.Ip == nil || *first.Ip != ip ||
		first.ConfirmedAt != nil || first.CancelledAt != nil {
		t.Fatalf("created: %+v", first)
	}

	got, err := q.GetRecoveryRequestByTokenHash(ctx, "tok-1")
	if err != nil || got.ID != first.ID {
		t.Fatalf("get: %+v %v", got, err)
	}
	if _, err := q.GetRecoveryRequestByTokenHash(ctx, "unknown"); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("unknown token: want ErrNoRows, got %v", err)
	}

	// A new request cancels the pending ones.
	if n, err := q.CancelPendingRecoveryRequestsForUser(ctx, db.CancelPendingRecoveryRequestsForUserParams{Now: now, UserID: ada.ID}); err != nil || n != 1 {
		t.Fatalf("cancel pending = %d, %v; want 1", n, err)
	}
	if _, err := q.ConfirmRecoveryRequest(ctx, db.ConfirmRecoveryRequestParams{Now: now.Add(delay), ID: first.ID}); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("confirm a cancelled request: want ErrNoRows, got %v", err)
	}
	second := create("tok-2", now)

	t.Run("confirm only after the cooling-off period", func(t *testing.T) {
		if _, err := q.ConfirmRecoveryRequest(ctx, db.ConfirmRecoveryRequestParams{Now: now.Add(delay - time.Second), ID: second.ID}); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("confirm before ready_at: want ErrNoRows, got %v", err)
		}
		done, err := q.ConfirmRecoveryRequest(ctx, db.ConfirmRecoveryRequestParams{Now: now.Add(delay), ID: second.ID})
		if err != nil || done.ConfirmedAt == nil || !done.ConfirmedAt.Equal(now.Add(delay)) {
			t.Fatalf("confirm at ready_at: %+v %v", done, err)
		}
		if _, err := q.ConfirmRecoveryRequest(ctx, db.ConfirmRecoveryRequestParams{Now: now.Add(delay), ID: second.ID}); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("second confirm: want ErrNoRows, got %v", err)
		}
		if _, err := q.CancelRecoveryRequest(ctx, db.CancelRecoveryRequestParams{Now: now.Add(delay), ID: second.ID}); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("cancel a confirmed request: want ErrNoRows, got %v", err)
		}
	})

	t.Run("cancel a pending request", func(t *testing.T) {
		third := create("tok-3", now)
		cancelled, err := q.CancelRecoveryRequest(ctx, db.CancelRecoveryRequestParams{Now: now.Add(time.Minute), ID: third.ID})
		if err != nil || cancelled.CancelledAt == nil || !cancelled.CancelledAt.Equal(now.Add(time.Minute)) {
			t.Fatalf("cancel: %+v %v", cancelled, err)
		}
		if _, err := q.CancelRecoveryRequest(ctx, db.CancelRecoveryRequestParams{Now: now.Add(time.Minute), ID: third.ID}); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("second cancel: want ErrNoRows, got %v", err)
		}
		if n, err := q.CancelPendingRecoveryRequestsForUser(ctx, db.CancelPendingRecoveryRequestsForUserParams{Now: now, UserID: ada.ID}); err != nil || n != 0 {
			t.Fatalf("nothing pending = %d, %v; want 0", n, err)
		}
	})
}
