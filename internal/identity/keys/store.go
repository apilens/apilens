package keys

import (
	"context"
	"crypto"
	"crypto/x509"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/identity/store/db"
)

// ErrNotFound is returned by Retire when no unretired key has the kid.
var ErrNotFound = errors.New("keys: signing key not found or already retired")

// Store reads and writes signing keys, sealing private keys under the KEK.
type Store struct {
	q      *db.Queries
	sealer *Sealer
}

// NewStore returns a Store over q that seals private keys with kek
// (config.IdentityConfig.KEK()).
func NewStore(q *db.Queries, kek []byte) (*Store, error) {
	sealer, err := NewSealer(kek)
	if err != nil {
		return nil, err
	}
	return &Store{q: q, sealer: sealer}, nil
}

// WithTx returns a Store whose statements run in tx, so a rotation can retire
// the old key and create the new one atomically.
func (s *Store) WithTx(tx pgx.Tx) *Store {
	return &Store{q: s.q.WithTx(tx), sealer: s.sealer}
}

// additionalData binds a sealed private key to its row.
func additionalData(kid string) []byte { return []byte("apilens/signing_keys/" + kid) }

// Create stores signer as a new RS256 key, keyed by its RFC 7638 thumbprint.
// With activate it signs new tokens at once; at most one key may be active,
// so retire the current one first (in the same transaction). Without
// activate it is published in JWKS but does not sign yet.
func (s *Store) Create(ctx context.Context, signer crypto.Signer, activate bool) (Key, error) {
	priv, err := rsaKey(signer)
	if err != nil {
		return Key{}, err
	}
	kid := Thumbprint(&priv.PublicKey)
	jwk, err := publicJWK(kid, &priv.PublicKey)
	if err != nil {
		return Key{}, fmt.Errorf("keys: public JWK: %w", err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return Key{}, fmt.Errorf("keys: encode private key: %w", err)
	}
	sealed, err := s.sealer.Seal(der, additionalData(kid))
	clear(der)
	if err != nil {
		return Key{}, err
	}
	var activatedAt *time.Time
	if activate {
		now := time.Now()
		activatedAt = &now
	}
	row, err := s.q.InsertSigningKey(ctx, db.InsertSigningKeyParams{
		Kid: kid, Alg: AlgRS256, PublicJwk: jwk, PrivateKeyEnc: sealed, ActivatedAt: activatedAt,
	})
	if err != nil {
		return Key{}, fmt.Errorf("keys: insert %s: %w", kid, err)
	}
	return keyFromRow(row, priv), nil
}

// Load returns the published keys, active key first: every key not yet
// retired, and keys retired less than retiredWindow ago. Pass
// identity.refresh_token_ttl as retiredWindow (see the package doc for why).
// It fails if any private key cannot be decrypted, so a wrong KEK fails
// closed at startup rather than serving a partial key set.
func (s *Store) Load(ctx context.Context, retiredWindow time.Duration) ([]Key, error) {
	rows, err := s.q.ListPublishedSigningKeys(ctx, retiredWindow.Seconds())
	if err != nil {
		return nil, fmt.Errorf("keys: load: %w", err)
	}
	keys := make([]Key, 0, len(rows))
	for _, row := range rows {
		signer, err := s.open(row)
		if err != nil {
			return nil, err
		}
		keys = append(keys, keyFromRow(row, signer))
	}
	return keys, nil
}

// Retire stops the key from signing. It stays published for the retirement
// window. ErrNotFound if no unretired key has kid.
func (s *Store) Retire(ctx context.Context, kid string) error {
	if _, err := s.q.RetireSigningKey(ctx, kid); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return fmt.Errorf("keys: retire %s: %w", kid, err)
	}
	return nil
}

func (s *Store) open(row db.SigningKey) (crypto.Signer, error) {
	if row.Alg != AlgRS256 {
		return nil, fmt.Errorf("keys: key %s has unsupported alg %q", row.Kid, row.Alg)
	}
	der, err := s.sealer.Open(row.PrivateKeyEnc, additionalData(row.Kid))
	if err != nil {
		return nil, fmt.Errorf("keys: key %s: %w", row.Kid, err)
	}
	parsed, err := x509.ParsePKCS8PrivateKey(der)
	clear(der)
	if err != nil {
		// Do not wrap: parse errors may quote the input.
		return nil, fmt.Errorf("keys: key %s: private key is not valid PKCS#8", row.Kid)
	}
	signer, ok := parsed.(crypto.Signer)
	if !ok {
		return nil, fmt.Errorf("keys: key %s: private key is not a signer", row.Kid)
	}
	priv, err := rsaKey(signer)
	if err != nil {
		return nil, fmt.Errorf("keys: key %s: %w", row.Kid, err)
	}
	if Thumbprint(&priv.PublicKey) != row.Kid {
		return nil, fmt.Errorf("keys: key %s: private key does not match its kid", row.Kid)
	}
	return priv, nil
}

func keyFromRow(row db.SigningKey, signer crypto.Signer) Key {
	return Key{
		KID: row.Kid, Alg: row.Alg, PublicJWK: row.PublicJwk,
		CreatedAt: row.CreatedAt, ActivatedAt: row.ActivatedAt, RetiredAt: row.RetiredAt,
		private: signer,
	}
}
