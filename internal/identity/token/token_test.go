package token

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/identity/keys"
	"github.com/apilens/apilens/internal/identity/store/db"
)

const testIssuer = "https://id.example.com"

type keySet []keys.Key

func (s keySet) Active() (keys.Key, bool) { return keys.Active(s) }
func (s keySet) All() []keys.Key          { return slices.Clone(s) }

func newKey(t *testing.T, active bool) keys.Key {
	t.Helper()
	priv, err := rsa.GenerateKey(rand.Reader, keys.MinRSABits)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	var activated, retired *time.Time
	if active {
		activated = &now
	} else {
		activated, retired = &now, &now
	}
	k, err := keys.Unstored(priv, activated, retired)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func newIssuer(t *testing.T, ks KeySource, now time.Time) *Issuer {
	t.Helper()
	iss, err := New(ks, Options{Issuer: testIssuer, TTL: 15 * time.Minute, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	return iss
}

func fixtures() (db.User, db.Session) {
	user := db.User{ID: uuid.New(), Email: "ada@example.com"}
	return user, db.Session{ID: uuid.New(), UserID: user.ID, FamilyID: uuid.New()}
}

func decodeSegment(t *testing.T, raw string, i int) map[string]any {
	t.Helper()
	b, err := base64.RawURLEncoding.DecodeString(strings.Split(raw, ".")[i])
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestIssueAndVerify(t *testing.T) {
	key := newKey(t, true)
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	iss := newIssuer(t, keySet{key}, now)
	user, session := fixtures()
	session.CreatedAt = now.Add(-7*time.Minute - 300*time.Millisecond)

	raw, exp, err := iss.Issue(user, session, []string{AMREmail, AMRTOTP})
	if err != nil {
		t.Fatal(err)
	}
	if want := now.Add(15 * time.Minute); !exp.Equal(want) {
		t.Errorf("exp = %v, want %v", exp, want)
	}

	header := decodeSegment(t, raw, 0)
	if header["alg"] != "RS256" || header["kid"] != key.KID || header["typ"] != "JWT" {
		t.Errorf("header = %v", header)
	}
	payload := decodeSegment(t, raw, 1)
	for _, name := range []string{"iss", "sub", "aud", "iat", "exp", "sid", "amr", "auth_time"} {
		if _, ok := payload[name]; !ok {
			t.Errorf("payload is missing %q: %v", name, payload)
		}
	}
	if payload["email"] != nil {
		t.Errorf("payload must not carry the email: %v", payload)
	}

	claims, err := iss.Verify(raw)
	if err != nil {
		t.Fatal(err)
	}
	if claims.Issuer != testIssuer || claims.Subject != user.ID.String() || claims.SessionID != session.ID.String() {
		t.Errorf("claims = %+v", claims)
	}
	if !slices.Equal(claims.Audience, jwt.ClaimStrings{Audience}) {
		t.Errorf("aud = %v", claims.Audience)
	}
	if !slices.Equal(claims.AMR, []string{AMREmail, AMRTOTP}) {
		t.Errorf("amr = %v", claims.AMR)
	}
	if !claims.IssuedAt.Equal(now) || !claims.ExpiresAt.Equal(exp) {
		t.Errorf("iat/exp = %v %v", claims.IssuedAt, claims.ExpiresAt)
	}
	// auth_time is the session's sign-in time, in whole seconds.
	if want := now.Add(-7*time.Minute - time.Second); claims.AuthTime == nil || !claims.AuthTime.Equal(want) {
		t.Errorf("auth_time = %v, want %v", claims.AuthTime, want)
	}
}

func TestVerifyExpired(t *testing.T) {
	ks := keySet{newKey(t, true)}
	now := time.Now()
	user, session := fixtures()
	raw, _, err := newIssuer(t, ks, now).Issue(user, session, []string{AMREmail})
	if err != nil {
		t.Fatal(err)
	}
	// Within the leeway the token still verifies; past it, it is expired.
	if _, err := newIssuer(t, ks, now.Add(15*time.Minute+Leeway/2)).Verify(raw); err != nil {
		t.Fatalf("within leeway: %v", err)
	}
	_, err = newIssuer(t, ks, now.Add(15*time.Minute+Leeway+time.Second)).Verify(raw)
	if !errors.Is(err, ErrExpired) {
		t.Fatalf("err = %v, want ErrExpired", err)
	}
}

func TestVerifyWrongAudience(t *testing.T) {
	key := newKey(t, true)
	now := time.Now()
	iss := newIssuer(t, keySet{key}, now)
	user, session := fixtures()

	claims := Claims{
		SessionID: session.ID.String(),
		AMR:       []string{AMREmail},
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer: testIssuer, Subject: user.ID.String(), Audience: jwt.ClaimStrings{"someone-else"},
			IssuedAt: jwt.NewNumericDate(now), ExpiresAt: jwt.NewNumericDate(now.Add(time.Minute)),
		},
	}
	raw := sign(t, key, claims)
	if _, err := iss.Verify(raw); !errors.Is(err, ErrInvalid) || !errors.Is(err, jwt.ErrTokenInvalidAudience) {
		t.Fatalf("err = %v, want ErrInvalid (audience)", err)
	}

	// Sanity: the same hand-signed token with the right audience verifies.
	claims.Audience = jwt.ClaimStrings{Audience}
	if _, err := iss.Verify(sign(t, key, claims)); err != nil {
		t.Fatalf("control: %v", err)
	}
}

func TestVerifyWrongIssuer(t *testing.T) {
	ks := keySet{newKey(t, true)}
	now := time.Now()
	user, session := fixtures()
	other, err := New(ks, Options{Issuer: "https://evil.example.com", TTL: time.Minute, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	raw, _, err := other.Issue(user, session, []string{AMREmail})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := newIssuer(t, ks, now).Verify(raw); !errors.Is(err, ErrInvalid) {
		t.Fatalf("err = %v, want ErrInvalid", err)
	}
}

func TestVerifyUnknownKID(t *testing.T) {
	signing := newKey(t, true)
	now := time.Now()
	user, session := fixtures()
	raw, _, err := newIssuer(t, keySet{signing}, now).Issue(user, session, []string{AMRPasskey})
	if err != nil {
		t.Fatal(err)
	}
	// A verifier whose published set lacks the signing key.
	if _, err := newIssuer(t, keySet{newKey(t, true)}, now).Verify(raw); !errors.Is(err, ErrUnknownKey) {
		t.Fatalf("err = %v, want ErrUnknownKey", err)
	}

	// No kid header at all.
	claims := Claims{SessionID: session.ID.String(), AMR: []string{AMREmail}, RegisteredClaims: jwt.RegisteredClaims{
		Issuer: testIssuer, Subject: user.ID.String(), Audience: jwt.ClaimStrings{Audience},
		IssuedAt: jwt.NewNumericDate(now), ExpiresAt: jwt.NewNumericDate(now.Add(time.Minute)),
	}}
	priv := signing.Signer().(*rsa.PrivateKey)
	noKID, err := jwt.NewWithClaims(jwt.SigningMethodRS256, claims).SignedString(priv)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := newIssuer(t, keySet{signing}, now).Verify(noKID); !errors.Is(err, ErrUnknownKey) {
		t.Fatalf("no kid: err = %v, want ErrUnknownKey", err)
	}
}

func TestVerifyRetiredKeyStillVerifies(t *testing.T) {
	old := newKey(t, true)
	now := time.Now()
	user, session := fixtures()
	raw, _, err := newIssuer(t, keySet{old}, now).Issue(user, session, []string{AMRGitHub})
	if err != nil {
		t.Fatal(err)
	}
	retired := old
	retired.RetiredAt = &now
	if _, err := newIssuer(t, keySet{newKey(t, true), retired}, now).Verify(raw); err != nil {
		t.Fatalf("token signed by a retired, still published key: %v", err)
	}
}

func TestVerifyTamperedSignature(t *testing.T) {
	key := newKey(t, true)
	now := time.Now()
	iss := newIssuer(t, keySet{key}, now)
	user, session := fixtures()
	raw, _, err := iss.Issue(user, session, []string{AMREmail})
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(raw, ".")

	// Flip a bit in the signature.
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatal(err)
	}
	sig[0] ^= 0x01
	badSig := parts[0] + "." + parts[1] + "." + base64.RawURLEncoding.EncodeToString(sig)

	// Swap the subject for another user, keeping the original signature.
	payload := decodeSegment(t, raw, 1)
	payload["sub"] = uuid.NewString()
	b, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	badPayload := parts[0] + "." + base64.RawURLEncoding.EncodeToString(b) + "." + parts[2]

	// Downgrade to an unsigned token.
	none := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT","kid":"`+key.KID+`"}`)) + "." + parts[1] + "."

	// HS256 keyed with the public JWK (algorithm confusion).
	hs := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims(payload))
	hs.Header["kid"] = key.KID
	confused, err := hs.SignedString([]byte(key.PublicJWK))
	if err != nil {
		t.Fatal(err)
	}

	for name, tok := range map[string]string{
		"signature": badSig, "payload": badPayload, "alg none": none, "alg confusion": confused, "garbage": "not.a.jwt",
	} {
		if _, err := iss.Verify(tok); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: err = %v, want ErrInvalid", name, err)
		}
	}
}

func TestIssueRejects(t *testing.T) {
	now := time.Now()
	user, session := fixtures()
	iss := newIssuer(t, keySet{newKey(t, true)}, now)

	if _, _, err := iss.Issue(user, session, nil); err == nil {
		t.Error("empty amr: want error")
	}
	if _, _, err := iss.Issue(user, session, []string{"pwd"}); err == nil {
		t.Error("unknown amr: want error")
	}
	other := session
	other.UserID = uuid.New()
	if _, _, err := iss.Issue(user, other, []string{AMREmail}); err == nil {
		t.Error("session of another user: want error")
	}
	revoked := session
	revoked.RevokedAt = &now
	if _, _, err := iss.Issue(user, revoked, []string{AMREmail}); err == nil {
		t.Error("revoked session: want error")
	}
	if _, _, err := newIssuer(t, keySet{newKey(t, false)}, now).Issue(user, session, []string{AMREmail}); !errors.Is(err, ErrNoActiveKey) {
		t.Errorf("no active key: err = %v, want ErrNoActiveKey", err)
	}
}

func TestNewValidates(t *testing.T) {
	if _, err := New(keySet{}, Options{TTL: time.Minute}); err == nil {
		t.Error("missing issuer: want error")
	}
	if _, err := New(keySet{}, Options{Issuer: testIssuer}); err == nil {
		t.Error("zero TTL: want error")
	}
}

func sign(t *testing.T, key keys.Key, claims Claims) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	tok.Header["kid"] = key.KID
	raw, err := tok.SignedString(key.Signer().(*rsa.PrivateKey))
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
