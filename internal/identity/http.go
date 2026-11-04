package identity

import (
	"net/http"
	"net/url"
	"slices"
	"strings"

	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/server"
)

// AuthPrefix is the path prefix of the identity auth endpoints.
const AuthPrefix = server.APIPrefix + "/auth"

// CORS response values used when an origin is allowed. Identity never sets
// cookies, so credentials are never allowed.
const (
	corsAllowMethods = "GET, POST, PUT, PATCH, DELETE"
	corsAllowHeaders = "Authorization, Content-Type"
	corsMaxAge       = "600"
)

// Middleware returns the HTTP posture for the identity endpoints under
// AuthPrefix. Other paths pass through untouched.
//
// Posture:
//   - Every response is uncacheable and leaks nothing through Referer or
//     MIME sniffing: Cache-Control: no-store, Referrer-Policy: no-referrer,
//     X-Content-Type-Options: nosniff.
//   - CORS is deny-by-default. Only origins in identity.cors_origins get CORS
//     headers, without credentials. A preflight from any other origin is
//     answered 403.
//   - CSRF. Identity sets no cookies (the UI server owns the session cookie)
//     and authenticates with bearer tokens or request bodies, so there is no
//     ambient credential to ride. As defence in depth, a state-changing
//     request whose Origin header is neither the issuer's origin nor an
//     allowed CORS origin is rejected with 403. Server-side callers (the UI's
//     Route Handlers) send no Origin header and are unaffected.
func Middleware(cfg config.IdentityConfig) func(http.Handler) http.Handler {
	allowed := make([]string, 0, len(cfg.CORSOrigins))
	for _, o := range cfg.CORSOrigins {
		allowed = append(allowed, normalizeOrigin(o))
	}
	self := normalizeOrigin(cfg.Issuer)

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !isAuthPath(r.URL.Path) {
				next.ServeHTTP(w, r)
				return
			}
			h := w.Header()
			h.Set("Cache-Control", "no-store")
			h.Set("Referrer-Policy", "no-referrer")
			h.Set("X-Content-Type-Options", "nosniff")
			h.Add("Vary", "Origin")

			origin := r.Header.Get("Origin")
			corsOK := origin != "" && slices.Contains(allowed, normalizeOrigin(origin))

			if r.Method == http.MethodOptions && origin != "" && r.Header.Get("Access-Control-Request-Method") != "" {
				if !corsOK {
					writeForbidden(w, "cors_origin_denied")
					return
				}
				h.Set("Access-Control-Allow-Origin", origin)
				h.Set("Access-Control-Allow-Methods", corsAllowMethods)
				h.Set("Access-Control-Allow-Headers", corsAllowHeaders)
				h.Set("Access-Control-Max-Age", corsMaxAge)
				w.WriteHeader(http.StatusNoContent)
				return
			}

			if origin != "" && !safeMethod(r.Method) && !corsOK && normalizeOrigin(origin) != self {
				writeForbidden(w, "cross_origin_denied")
				return
			}
			if corsOK {
				h.Set("Access-Control-Allow-Origin", origin)
			}
			next.ServeHTTP(w, r)
		})
	}
}

func isAuthPath(p string) bool {
	return p == AuthPrefix || strings.HasPrefix(p, AuthPrefix+"/")
}

func safeMethod(m string) bool {
	return m == http.MethodGet || m == http.MethodHead || m == http.MethodOptions
}

// normalizeOrigin lower-cases scheme and host and drops default ports, so
// "HTTPS://App.example.com:443" matches "https://app.example.com". Values
// that are not http(s) origins (including the literal "null") normalize to
// "", which never matches.
func normalizeOrigin(v string) string {
	u, err := url.Parse(strings.TrimSpace(v))
	if err != nil || u.Host == "" {
		return ""
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return ""
	}
	host := strings.ToLower(u.Hostname())
	port := u.Port()
	if (scheme == "http" && port == "80") || (scheme == "https" && port == "443") {
		port = ""
	}
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	if port != "" {
		host += ":" + port
	}
	return scheme + "://" + host
}

func writeForbidden(w http.ResponseWriter, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusForbidden)
	_, _ = w.Write([]byte(`{"error":"` + code + `","detail":"Cross-origin request denied"}`))
}
