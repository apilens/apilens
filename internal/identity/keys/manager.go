package keys

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"fmt"
	"log/slog"
	"slices"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

// RSABits is the modulus size of keys identity generates.
const RSABits = MinRSABits

// DefaultRefreshInterval is how often a Manager reloads the published key
// set, so a rotation made by `apilens identity rotate-key` (or another
// identity replica) reaches every replica within a minute.
const DefaultRefreshInterval = 60 * time.Second

// lockKey is the Postgres advisory lock that serialises key creation and
// rotation across identity replicas and the CLI ("apilens.signing_keys").
const lockKey int64 = 0x6170696c656e7301

// TxBeginner starts transactions; *pgxpool.Pool satisfies it.
type TxBeginner interface {
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Manager owns the signing key lifecycle for one identity process: it makes
// sure an active key exists, rotates keys, and serves the published set from
// an in-process cache refreshed every RefreshInterval.
type Manager struct {
	db       TxBeginner
	store    *Store
	window   time.Duration
	interval time.Duration
	logger   *slog.Logger

	mu   sync.RWMutex
	keys []Key
}

// ManagerOptions configures a Manager.
type ManagerOptions struct {
	// RetiredWindow keeps retired keys published; pass
	// identity.refresh_token_ttl (see the package doc).
	RetiredWindow time.Duration
	// RefreshInterval is how often Run reloads the key set. Zero means
	// DefaultRefreshInterval.
	RefreshInterval time.Duration
}

// NewManager returns a Manager over store; db runs the transactions that
// create and rotate keys. Its cache is empty until Ensure or Refresh.
func NewManager(db TxBeginner, store *Store, opts ManagerOptions, logger *slog.Logger) *Manager {
	if opts.RefreshInterval <= 0 {
		opts.RefreshInterval = DefaultRefreshInterval
	}
	return &Manager{db: db, store: store, window: opts.RetiredWindow, interval: opts.RefreshInterval, logger: logger}
}

// Active returns the cached key that signs new tokens. ok is false only if
// the cache holds no active key (before Ensure, or if every key was removed).
func (m *Manager) Active() (Key, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return Active(m.keys)
}

// All returns the cached published keys (the JWKS set), active key first.
func (m *Manager) All() []Key {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return slices.Clone(m.keys)
}

// Refresh reloads the published key set into the cache.
func (m *Manager) Refresh(ctx context.Context) error {
	loaded, err := m.store.Load(ctx, m.window)
	if err != nil {
		return err
	}
	m.mu.Lock()
	m.keys = loaded
	m.mu.Unlock()
	return nil
}

// Ensure creates an RS256 key and activates it if no key is active (a fresh
// database), then fills the cache. It is safe to call from several replicas
// booting at once: creation runs under an advisory lock, so exactly one
// active key results. created reports whether this call made the key.
func (m *Manager) Ensure(ctx context.Context) (active Key, created bool, err error) {
	err = m.inLockedTx(ctx, func(s *Store) error {
		loaded, err := s.Load(ctx, m.window)
		if err != nil {
			return err
		}
		if k, ok := Active(loaded); ok {
			active = k
			return nil
		}
		active, err = createActive(ctx, s)
		created = err == nil
		return err
	})
	if err != nil {
		return Key{}, false, err
	}
	if created {
		m.logger.Info("created signing key", "key", active)
	}
	if err := m.Refresh(ctx); err != nil {
		return Key{}, false, err
	}
	return active, created, nil
}

// Rotate retires the active key (if any) and activates a newly generated
// one, atomically. The retired key stays published for the retirement
// window, so tokens it signed keep verifying until they expire. retired is
// empty if there was no active key. Other replicas pick the new key up on
// their next refresh; until then they keep signing with the retired key,
// which is still published.
func (m *Manager) Rotate(ctx context.Context) (active Key, retired string, err error) {
	err = m.inLockedTx(ctx, func(s *Store) error {
		loaded, err := s.Load(ctx, m.window)
		if err != nil {
			return err
		}
		if old, ok := Active(loaded); ok {
			if err := s.Retire(ctx, old.KID); err != nil {
				return err
			}
			retired = old.KID
		}
		active, err = createActive(ctx, s)
		return err
	})
	if err != nil {
		return Key{}, "", err
	}
	m.logger.Info("rotated signing key", "key", active, "retired_kid", retired)
	if err := m.Refresh(ctx); err != nil {
		return Key{}, "", err
	}
	return active, retired, nil
}

// Run refreshes the cache every RefreshInterval until ctx is done. A failed
// refresh keeps the previous key set (still valid: keys only change by
// rotation, which leaves the old key published) and is retried next tick.
func (m *Manager) Run(ctx context.Context) error {
	t := time.NewTicker(m.interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
			if err := m.Refresh(ctx); err != nil && ctx.Err() == nil {
				m.logger.Warn("signing key refresh failed; serving the cached key set", "err", err)
			}
		}
	}
}

// inLockedTx runs fn in a transaction holding the signing key advisory lock.
func (m *Manager) inLockedTx(ctx context.Context, fn func(*Store) error) error {
	tx, err := m.db.Begin(ctx)
	if err != nil {
		return fmt.Errorf("keys: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock($1)", lockKey); err != nil {
		return fmt.Errorf("keys: lock: %w", err)
	}
	if err := fn(m.store.WithTx(tx)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("keys: commit: %w", err)
	}
	return nil
}

// createActive generates an RS256 key and stores it as the active key.
func createActive(ctx context.Context, s *Store) (Key, error) {
	priv, err := rsa.GenerateKey(rand.Reader, RSABits)
	if err != nil {
		return Key{}, fmt.Errorf("keys: generate: %w", err)
	}
	return s.Create(ctx, priv, true)
}
