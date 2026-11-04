//go:build integration

package store_test

import (
	"bytes"
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/testutil"
)

func TestPasskeyCredentials(t *testing.T) {
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
	aaguid := uuid.MustParse("fbfc3007-154e-4ecc-8c0b-6e020557d7bd")

	laptop, err := q.CreatePasskeyCredential(ctx, db.CreatePasskeyCredentialParams{
		ID: uuid.New(), UserID: ada.ID, CredentialID: []byte("cred-laptop"), PublicKey: []byte{0xa5, 0x01},
		AttestationType: "none", Aaguid: aaguid, SignCount: 0, Transports: []string{"internal", "hybrid"},
		BackupEligible: true, BackupState: true, Name: "MacBook",
	})
	if err != nil {
		t.Fatal(err)
	}
	if laptop.UserID != ada.ID || !bytes.Equal(laptop.CredentialID, []byte("cred-laptop")) || laptop.Aaguid != aaguid ||
		!slices.Equal(laptop.Transports, []string{"internal", "hybrid"}) || !laptop.BackupEligible || !laptop.BackupState ||
		laptop.LastUsedAt != nil || laptop.CreatedAt.IsZero() {
		t.Fatalf("created: %+v", laptop)
	}
	key, err := q.CreatePasskeyCredential(ctx, db.CreatePasskeyCredentialParams{
		ID: uuid.New(), UserID: ada.ID, CredentialID: []byte("cred-key"), PublicKey: []byte{0xa5, 0x02},
		AttestationType: "packed", SignCount: 7, Transports: []string{}, Name: "YubiKey",
	})
	if err != nil {
		t.Fatalf("second passkey for one user: %v", err)
	}
	if key.Aaguid != uuid.Nil || key.Transports == nil || len(key.Transports) != 0 || key.SignCount != 7 {
		t.Fatalf("second passkey: %+v", key)
	}

	t.Run("a credential id belongs to one user", func(t *testing.T) {
		if _, err := q.CreatePasskeyCredential(ctx, db.CreatePasskeyCredentialParams{
			ID: uuid.New(), UserID: bob.ID, CredentialID: []byte("cred-key"), PublicKey: []byte{1},
			Transports: []string{}, Name: "Copy",
		}); err == nil {
			t.Fatal("registering an already registered credential_id should fail")
		}
	})

	t.Run("get by credential id", func(t *testing.T) {
		got, err := q.GetPasskeyCredentialByCredentialID(ctx, []byte("cred-key"))
		if err != nil || got.ID != key.ID || got.UserID != ada.ID || !bytes.Equal(got.PublicKey, []byte{0xa5, 0x02}) {
			t.Fatalf("got %+v %v", got, err)
		}
		if _, err := q.GetPasskeyCredentialByCredentialID(ctx, []byte("unknown")); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("unknown credential: want ErrNoRows, got %v", err)
		}
	})

	t.Run("list and count for user", func(t *testing.T) {
		list, err := q.ListPasskeyCredentialsForUser(ctx, ada.ID)
		if err != nil || len(list) != 2 || list[0].ID != laptop.ID || list[1].ID != key.ID {
			t.Fatalf("list: %+v %v", list, err)
		}
		if n, err := q.CountPasskeyCredentialsForUser(ctx, ada.ID); err != nil || n != 2 {
			t.Fatalf("count: %d %v", n, err)
		}
		empty, err := q.ListPasskeyCredentialsForUser(ctx, bob.ID)
		if err != nil || empty == nil || len(empty) != 0 {
			t.Fatalf("list for user without passkeys: %#v %v", empty, err)
		}
		if n, err := q.CountPasskeyCredentialsForUser(ctx, bob.ID); err != nil || n != 0 {
			t.Fatalf("count for user without passkeys: %d %v", n, err)
		}
	})

	t.Run("update sign count", func(t *testing.T) {
		if n, err := q.UpdatePasskeySignCount(ctx, db.UpdatePasskeySignCountParams{ID: key.ID, SignCount: 8, BackupState: false}); err != nil || n != 1 {
			t.Fatalf("update: %d %v; want 1", n, err)
		}
		got, err := q.GetPasskeyCredentialByCredentialID(ctx, []byte("cred-key"))
		if err != nil || got.SignCount != 8 || got.BackupState || got.LastUsedAt == nil {
			t.Fatalf("after update: %+v %v", got, err)
		}
		if n, err := q.UpdatePasskeySignCount(ctx, db.UpdatePasskeySignCountParams{ID: uuid.New(), SignCount: 1}); err != nil || n != 0 {
			t.Fatalf("update of a missing credential: %d %v; want 0", n, err)
		}
		// BS cannot be set on a credential that is not backup eligible.
		if _, err := q.UpdatePasskeySignCount(ctx, db.UpdatePasskeySignCountParams{ID: key.ID, SignCount: 9, BackupState: true}); err == nil {
			t.Fatal("backup_state on a non-eligible credential should fail")
		}
	})

	t.Run("rename is scoped to the user", func(t *testing.T) {
		if n, err := q.RenamePasskeyCredential(ctx, db.RenamePasskeyCredentialParams{ID: key.ID, UserID: bob.ID, Name: "Mine"}); err != nil || n != 0 {
			t.Fatalf("another user's rename: %d %v; want 0", n, err)
		}
		if n, err := q.RenamePasskeyCredential(ctx, db.RenamePasskeyCredentialParams{ID: key.ID, UserID: ada.ID, Name: "Work key"}); err != nil || n != 1 {
			t.Fatalf("rename: %d %v; want 1", n, err)
		}
		if _, err := q.RenamePasskeyCredential(ctx, db.RenamePasskeyCredentialParams{ID: key.ID, UserID: ada.ID, Name: ""}); err == nil {
			t.Fatal("empty name should be rejected")
		}
		got, err := q.GetPasskeyCredentialByCredentialID(ctx, []byte("cred-key"))
		if err != nil || got.Name != "Work key" {
			t.Fatalf("after rename: %+v %v", got, err)
		}
	})

	t.Run("delete is scoped to the user", func(t *testing.T) {
		if n, err := q.DeletePasskeyCredential(ctx, db.DeletePasskeyCredentialParams{ID: key.ID, UserID: bob.ID}); err != nil || n != 0 {
			t.Fatalf("another user's delete: %d %v; want 0", n, err)
		}
		if n, err := q.DeletePasskeyCredential(ctx, db.DeletePasskeyCredentialParams{ID: key.ID, UserID: ada.ID}); err != nil || n != 1 {
			t.Fatalf("delete: %d %v; want 1", n, err)
		}
		if n, err := q.CountPasskeyCredentialsForUser(ctx, ada.ID); err != nil || n != 1 {
			t.Fatalf("count after delete: %d %v", n, err)
		}
		if _, err := q.GetPasskeyCredentialByCredentialID(ctx, []byte("cred-key")); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("deleted credential: want ErrNoRows, got %v", err)
		}
	})
}
