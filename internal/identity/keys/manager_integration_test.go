//go:build integration

package keys_test

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/apilens/apilens/internal/identity/keys"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/testutil"
)

const testWindow = 720 * time.Hour

func newManager(t *testing.T, pool *pgxpool.Pool, kek []byte, interval time.Duration) *keys.Manager {
	t.Helper()
	store, err := keys.NewStore(db.New(pool), kek)
	if err != nil {
		t.Fatal(err)
	}
	return keys.NewManager(pool, store, keys.ManagerOptions{RetiredWindow: testWindow, RefreshInterval: interval}, testutil.Logger(t))
}

// publicKey parses a served JWK the way a JWKS verifier would.
func publicKey(t *testing.T, raw json.RawMessage) *rsa.PublicKey {
	t.Helper()
	var jwk struct{ Kty, Alg, Kid, N, E string }
	if err := json.Unmarshal(raw, &jwk); err != nil {
		t.Fatal(err)
	}
	if jwk.Kty != "RSA" || jwk.Alg != keys.AlgRS256 {
		t.Fatalf("jwk = %s", raw)
	}
	n, err := base64.RawURLEncoding.DecodeString(jwk.N)
	if err != nil {
		t.Fatal(err)
	}
	e, err := base64.RawURLEncoding.DecodeString(jwk.E)
	if err != nil {
		t.Fatal(err)
	}
	return &rsa.PublicKey{N: new(big.Int).SetBytes(n), E: int(new(big.Int).SetBytes(e).Int64())}
}

// token is an RS256 signature over a payload, tagged with the signing kid.
type token struct {
	kid     string
	payload []byte
	sig     []byte
}

func sign(t *testing.T, k keys.Key, payload string) token {
	t.Helper()
	digest := sha256.Sum256([]byte(payload))
	sig, err := k.Signer().Sign(rand.Reader, digest[:], crypto.SHA256)
	if err != nil {
		t.Fatal(err)
	}
	return token{kid: k.KID, payload: []byte(payload), sig: sig}
}

// verify checks tok against the published set, as a JWKS verifier does: find
// the key by kid, then check the signature.
func verify(t *testing.T, published []keys.Key, tok token) bool {
	t.Helper()
	for _, k := range published {
		if k.KID == tok.kid {
			digest := sha256.Sum256(tok.payload)
			return rsa.VerifyPKCS1v15(publicKey(t, k.PublicJWK), crypto.SHA256, digest[:], tok.sig) == nil
		}
	}
	return false
}

func countKeys(t *testing.T, pool db.DBTX) (total, active int) {
	t.Helper()
	err := pool.QueryRow(context.Background(),
		`SELECT count(*), count(*) FILTER (WHERE activated_at IS NOT NULL AND retired_at IS NULL) FROM signing_keys`).Scan(&total, &active)
	if err != nil {
		t.Fatal(err)
	}
	return total, active
}

func TestManagerFreshDatabaseBootsWithOneActiveKey(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)
	kek := randomKEK(t)

	// Several identity replicas booting at once against an empty table.
	const replicas = 4
	managers := make([]*keys.Manager, replicas)
	for i := range managers {
		managers[i] = newManager(t, pool, kek, 0)
	}
	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		created int
	)
	for _, m := range managers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, c, err := m.Ensure(ctx)
			if err != nil {
				t.Error(err)
				return
			}
			if c {
				mu.Lock()
				created++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if t.Failed() {
		return
	}
	if created != 1 {
		t.Fatalf("%d replicas created a key, want exactly 1", created)
	}
	if total, active := countKeys(t, pool); total != 1 || active != 1 {
		t.Fatalf("signing_keys has %d rows, %d active; want 1 and 1", total, active)
	}

	first, ok := managers[0].Active()
	if !ok || first.Alg != keys.AlgRS256 {
		t.Fatalf("active = %v, %t", first, ok)
	}
	if bits := publicKey(t, first.PublicJWK).N.BitLen(); bits != keys.RSABits {
		t.Fatalf("key is %d bits, want %d", bits, keys.RSABits)
	}
	for _, m := range managers {
		if k, ok := m.Active(); !ok || k.KID != first.KID || len(m.All()) != 1 {
			t.Fatalf("replica cache = %v", m.All())
		}
	}

	// A restart finds the existing key and creates nothing.
	again, created2, err := newManager(t, pool, kek, 0).Ensure(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if created2 || again.KID != first.KID {
		t.Fatalf("restart: created=%t kid=%s, want existing %s", created2, again.KID, first.KID)
	}
}

func TestManagerRotationKeepsOldTokensVerifiable(t *testing.T) {
	ctx := context.Background()
	pool := testutil.MigratedPostgres(t)
	kek := randomKEK(t)
	m := newManager(t, pool, kek, 0)

	old, _, err := m.Ensure(ctx)
	if err != nil {
		t.Fatal(err)
	}
	oldTok := sign(t, old, `{"sub":"u1","exp":1}`)

	// Another replica, whose cache refreshes on its own schedule.
	replica := newManager(t, pool, kek, 20*time.Millisecond)
	if err := replica.Refresh(ctx); err != nil {
		t.Fatal(err)
	}

	next, retired, err := m.Rotate(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if retired != old.KID || next.KID == old.KID || !next.Active() {
		t.Fatalf("rotate = %v, retired %q", next, retired)
	}
	if total, active := countKeys(t, pool); total != 2 || active != 1 {
		t.Fatalf("signing_keys has %d rows, %d active; want 2 and 1", total, active)
	}

	all := m.All()
	if len(all) != 2 || all[0].KID != next.KID || all[1].KID != old.KID || all[1].Active() {
		t.Fatalf("published after rotation = %v", all)
	}
	if active, _ := m.Active(); active.KID != next.KID {
		t.Fatalf("active = %v, want %s", active, next.KID)
	}
	if !verify(t, all, oldTok) {
		t.Fatal("token signed by the retired key no longer verifies")
	}
	if !verify(t, all, sign(t, next, `{"sub":"u2"}`)) {
		t.Fatal("token signed by the new key does not verify")
	}

	// The replica picks the new key up on its refresh loop.
	runCtx, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() { done <- replica.Run(runCtx) }()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if k, _ := replica.Active(); k.KID == next.KID {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("replica did not pick up the rotated key")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if !verify(t, replica.All(), oldTok) {
		t.Fatal("replica no longer verifies the retired key's token")
	}

	// Once the retirement window has passed the old key is dropped.
	if _, err := pool.Exec(ctx, `UPDATE signing_keys SET retired_at = now() - interval '721 hours' WHERE kid = $1`, old.KID); err != nil {
		t.Fatal(err)
	}
	if err := m.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	if verify(t, m.All(), oldTok) {
		t.Fatal("expired retired key is still published")
	}
}
