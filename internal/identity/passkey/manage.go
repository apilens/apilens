package passkey

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/store/db"
)

// ErrNotFound means the user has no passkey with that id (it never existed,
// was removed, or belongs to another user).
var ErrNotFound = errors.New("passkey: not found")

// Manager lists, renames and removes a signed-in user's passkeys.
type Manager struct {
	pool  TxBeginner
	q     *db.Queries
	audit *audit.Recorder
}

// NewManager returns the passkey manager over pool.
func NewManager(pool TxBeginner) *Manager {
	return &Manager{pool: pool, q: db.New(pool), audit: audit.New(pool)}
}

// List returns user's passkeys, oldest first.
func (m *Manager) List(ctx context.Context, user uuid.UUID) ([]db.PasskeyCredential, error) {
	creds, err := m.q.ListPasskeyCredentialsForUser(ctx, user)
	if err != nil {
		return nil, fmt.Errorf("passkey: list credentials: %w", err)
	}
	return creds, nil
}

// Rename sets the name of user's passkey id to name (trimmed and clamped to
// MaxNameLen; the caller rejects a blank name) and audits passkey.renamed in
// the same transaction. It returns the renamed passkey, or ErrNotFound.
func (m *Manager) Rename(ctx context.Context, user, id uuid.UUID, name string) (db.PasskeyCredential, error) {
	name = ClampName(name)
	if name == "" {
		return db.PasskeyCredential{}, errors.New("passkey: empty name")
	}
	var cred db.PasskeyCredential
	err := m.inTx(ctx, func(ctx context.Context, q *db.Queries) error {
		var err error
		cred, err = q.GetPasskeyCredentialForUser(ctx, db.GetPasskeyCredentialForUserParams{ID: id, UserID: user})
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("passkey: get credential: %w", err)
		}
		if cred.Name == name {
			return nil
		}
		n, err := q.RenamePasskeyCredential(ctx, db.RenamePasskeyCredentialParams{Name: name, ID: id, UserID: user})
		if err != nil {
			return fmt.Errorf("passkey: rename credential: %w", err)
		}
		if n == 0 {
			return ErrNotFound
		}
		from := cred.Name
		cred.Name = name
		return m.audit.Record(ctx, audit.Event{
			User:  &user,
			Actor: &user,
			Kind:  audit.PasskeyRenamed,
			Meta:  map[string]any{"passkey_id": id.String(), "from": from, "to": name},
		})
	})
	if err != nil {
		return db.PasskeyCredential{}, err
	}
	return cred, nil
}

// Delete removes user's passkey id and audits passkey.removed in the same
// transaction. It returns the removed passkey, or ErrNotFound.
func (m *Manager) Delete(ctx context.Context, user, id uuid.UUID) (db.PasskeyCredential, error) {
	var cred db.PasskeyCredential
	err := m.inTx(ctx, func(ctx context.Context, q *db.Queries) error {
		var err error
		cred, err = q.GetPasskeyCredentialForUser(ctx, db.GetPasskeyCredentialForUserParams{ID: id, UserID: user})
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("passkey: get credential: %w", err)
		}
		n, err := q.DeletePasskeyCredential(ctx, db.DeletePasskeyCredentialParams{ID: id, UserID: user})
		if err != nil {
			return fmt.Errorf("passkey: delete credential: %w", err)
		}
		if n == 0 {
			return ErrNotFound
		}
		return m.audit.Record(ctx, audit.Event{
			User:  &user,
			Actor: &user,
			Kind:  audit.PasskeyRemoved,
			Meta: map[string]any{
				"passkey_id": id.String(),
				"name":       cred.Name,
				"aaguid":     cred.Aaguid.String(),
			},
		})
	})
	if err != nil {
		return db.PasskeyCredential{}, err
	}
	return cred, nil
}

// inTx runs fn in a transaction whose audit events commit with it.
func (m *Manager) inTx(ctx context.Context, fn func(context.Context, *db.Queries) error) error {
	tx, err := m.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("passkey: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := fn(audit.WithTx(ctx, tx), m.q.WithTx(tx)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("passkey: commit: %w", err)
	}
	return nil
}
