package identity

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	signingkeys "github.com/apilens/apilens/internal/identity/keys"
)

// JWKSPath serves the public signing keys that the api and query roles (and
// any other verifier) use to check identity's access tokens locally.
const JWKSPath = "/.well-known/jwks.json"

// jwksCacheControl lets verifiers and proxies cache the key set for five
// minutes. A retired key stays published far longer than that (see package
// keys), so a cached set never lacks a key that still verifies live tokens.
const jwksCacheControl = "public, max-age=300"

// KeySource returns the published signing keys; *keys.Manager satisfies it.
type KeySource interface {
	All() []signingkeys.Key
}

// RegisterJWKS mounts GET /.well-known/jwks.json on mux as a plain handler,
// outside the typed API: the active key plus retired keys still inside their
// retirement window, public members only.
func RegisterJWKS(mux *http.ServeMux, src KeySource, logger *slog.Logger) {
	mux.Handle("GET "+JWKSPath, JWKSHandler(src, logger))
}

// JWKSHandler serves src's keys as a JWK Set with Cache-Control and a strong
// ETag derived from the body, answering a matching If-None-Match with 304.
func JWKSHandler(src KeySource, logger *slog.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		set, err := signingkeys.PublicSet(src.All())
		var body []byte
		if err == nil {
			body, err = json.Marshal(set)
		}
		if err != nil {
			logger.Error("jwks: render key set", "err", err)
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		sum := sha256.Sum256(body)
		etag := `"` + base64.RawURLEncoding.EncodeToString(sum[:16]) + `"`

		h := w.Header()
		h.Set("Cache-Control", jwksCacheControl)
		h.Set("ETag", etag)
		h.Set("X-Content-Type-Options", "nosniff")
		if etagMatches(r.Header.Get("If-None-Match"), etag) {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		h.Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		if r.Method != http.MethodHead {
			_, _ = w.Write(body)
		}
	})
}

// etagMatches applies the weak comparison If-None-Match uses (RFC 9110
// §13.1.2) of each tag in header against etag.
func etagMatches(header, etag string) bool {
	if header == "" {
		return false
	}
	for _, tag := range strings.Split(header, ",") {
		tag = strings.TrimSpace(tag)
		if tag == "*" || strings.TrimPrefix(tag, "W/") == etag {
			return true
		}
	}
	return false
}
