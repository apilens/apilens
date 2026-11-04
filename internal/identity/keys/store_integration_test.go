//go:build integration

package keys_test

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"errors"
	"testing"
	"time"

	"github.com/apilens/apilens/internal/identity/keys"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/testutil"
)

func newRSA(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	k, err := rsa.GenerateKey(rand.Reader, keys.MinRSABits)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func randomKEK(t *testing.T) []byte {
	t.Helper()
	kek := make([]byte, keys.KEKSize)
	if _, err := rand.Read(kek); err != nil {
		t.Fatal(err)
	}
	return kek
}

func TestStoreCreateLoadRetire(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)
	kek := randomKEK(t)
	store, err := keys.NewStore(db.New(pool), kek)
	if err != nil {
		t.Fatal(err)
	}
	window := 720 * time.Hour

	first := newRSA(t)
	k1, err := store.Create(ctx, first, true)
	if err != nil {
		t.Fatal(err)
	}
	if !k1.Active() || k1.KID != keys.Thumbprint(&first.PublicKey) {
		t.Fatalf("created key = %v", k1)
	}

	t.Run("private key is encrypted at rest", func(t *testing.T) {
		var enc []byte
		if err := pool.QueryRow(ctx, `SELECT private_key_enc FROM signing_keys WHERE kid = $1`, k1.KID).Scan(&enc); err != nil {
			t.Fatal(err)
		}
		der, err := x509.MarshalPKCS8PrivateKey(first)
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Equal(enc, der) || bytes.Contains(enc, first.D.Bytes()) || bytes.Contains(enc, der[len(der)-64:]) {
			t.Fatal("private_key_enc holds plaintext key material")
		}
	})

	t.Run("load round-trips the private key", func(t *testing.T) {
		loaded, err := store.Load(ctx, window)
		if err != nil {
			t.Fatal(err)
		}
		active, ok := keys.Active(loaded)
		if len(loaded) != 1 || !ok || active.KID != k1.KID {
			t.Fatalf("loaded = %v", loaded)
		}
		if !first.Equal(active.Signer()) {
			t.Fatal("decrypted private key differs from the stored one")
		}
		digest := sha256.Sum256([]byte("payload"))
		sig, err := active.Signer().Sign(rand.Reader, digest[:], crypto.SHA256)
		if err != nil {
			t.Fatal(err)
		}
		if err := rsa.VerifyPKCS1v15(&first.PublicKey, crypto.SHA256, digest[:], sig); err != nil {
			t.Fatalf("loaded key cannot sign: %v", err)
		}
	})

	t.Run("only one active key", func(t *testing.T) {
		if _, err := store.Create(ctx, newRSA(t), true); err == nil {
			t.Fatal("a second active key should violate signing_keys_one_active")
		}
	})

	second := newRSA(t)
	t.Run("rotate in a transaction", func(t *testing.T) {
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = tx.Rollback(ctx) }()
		txStore := store.WithTx(tx)
		if err := txStore.Retire(ctx, k1.KID); err != nil {
			t.Fatal(err)
		}
		if _, err := txStore.Create(ctx, second, true); err != nil {
			t.Fatal(err)
		}
		if err := tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("retired key stays published for the window", func(t *testing.T) {
		loaded, err := store.Load(ctx, window)
		if err != nil {
			t.Fatal(err)
		}
		if len(loaded) != 2 || !loaded[0].Active() || loaded[0].KID != keys.Thumbprint(&second.PublicKey) {
			t.Fatalf("want [new active, retired], got %v", loaded)
		}
		if loaded[1].KID != k1.KID || loaded[1].Active() || loaded[1].RetiredAt == nil {
			t.Fatalf("retired key = %v", loaded[1])
		}

		// Past the window it is no longer served.
		if _, err := pool.Exec(ctx, `UPDATE signing_keys SET retired_at = now() - interval '721 hours' WHERE kid = $1`, k1.KID); err != nil {
			t.Fatal(err)
		}
		loaded, err = store.Load(ctx, window)
		if err != nil {
			t.Fatal(err)
		}
		if len(loaded) != 1 || loaded[0].KID != keys.Thumbprint(&second.PublicKey) {
			t.Fatalf("expired retired key should not be published: %v", loaded)
		}
	})

	t.Run("pending key is published but not active", func(t *testing.T) {
		pending, err := store.Create(ctx, newRSA(t), false)
		if err != nil {
			t.Fatal(err)
		}
		loaded, err := store.Load(ctx, window)
		if err != nil {
			t.Fatal(err)
		}
		if len(loaded) != 2 || loaded[1].KID != pending.KID || loaded[1].Active() {
			t.Fatalf("loaded = %v", loaded)
		}
	})

	t.Run("retire unknown or retired key", func(t *testing.T) {
		for _, kid := range []string{"nope", k1.KID} {
			if err := store.Retire(ctx, kid); !errors.Is(err, keys.ErrNotFound) {
				t.Errorf("Retire(%s) = %v, want ErrNotFound", kid, err)
			}
		}
	})

	t.Run("wrong KEK fails closed", func(t *testing.T) {
		other, err := keys.NewStore(db.New(pool), randomKEK(t))
		if err != nil {
			t.Fatal(err)
		}
		if _, err := other.Load(ctx, window); !errors.Is(err, keys.ErrDecrypt) {
			t.Fatalf("Load with wrong KEK = %v, want ErrDecrypt", err)
		}
	})

	t.Run("ciphertext moved to another row fails", func(t *testing.T) {
		if _, err := pool.Exec(ctx, `UPDATE signing_keys SET private_key_enc = (SELECT private_key_enc FROM signing_keys WHERE kid = $1) WHERE kid <> $1`, k1.KID); err != nil {
			t.Fatal(err)
		}
		if _, err := store.Load(ctx, window); !errors.Is(err, keys.ErrDecrypt) {
			t.Fatalf("Load after swapping ciphertexts = %v, want ErrDecrypt", err)
		}
	})
}
