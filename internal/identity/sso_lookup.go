package identity

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"

	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/platform/server"
)

// SSOLookupStore finds the organization that uses SSO for an email domain;
// *db.Queries satisfies it.
type SSOLookupStore interface {
	LookupOrgSSOForDomain(ctx context.Context, domain string) (db.LookupOrgSSOForDomainRow, error)
}

// SSOLookupInput is the request of GET /api/v1/auth/sso/lookup.
type SSOLookupInput struct {
	Email string `query:"email" required:"true" minLength:"3" maxLength:"254" doc:"Address typed on the sign-in page; only its domain is looked up."`
}

// SSOLookupResponse says whether the email's domain signs in through an
// organization's SSO connection.
type SSOLookupResponse struct {
	SSO      bool   `json:"sso" doc:"An organization uses single sign-on for this email domain."`
	Enforced bool   `json:"enforced" doc:"That organization requires single sign-on: the sign-in page must skip the email code and send the user to start_url."`
	OrgName  string `json:"org_name,omitempty" doc:"Display name of the organization (only when sso is true)."`
	StartURL string `json:"start_url,omitempty" doc:"Where to send the browser to sign in through the organization's identity provider (only when sso is true)."`
}

// SSOLookupOutput is the response of GET /api/v1/auth/sso/lookup.
type SSOLookupOutput struct {
	Body SSOLookupResponse
}

// SSOLookup serves GET /api/v1/auth/sso/lookup.
type SSOLookup struct {
	store   SSOLookupStore
	issuer  string
	limiter *ratelimit.Limiter
	perIP   ratelimit.Rate
	logger  *slog.Logger
}

// NewSSOLookup returns the SSO lookup endpoint. limiter enforces
// identity.rate_limits.sso_lookup_per_ip.
func NewSSOLookup(cfg config.IdentityConfig, store SSOLookupStore, limiter *ratelimit.Limiter, logger *slog.Logger) *SSOLookup {
	return &SSOLookup{
		store:   store,
		issuer:  strings.TrimRight(cfg.Issuer, "/"),
		limiter: limiter,
		perIP:   ratelimit.Rate(cfg.RateLimits.SSOLookupPerIP),
		logger:  logger,
	}
}

// Register mounts GET /api/v1/auth/sso/lookup.
func (s *SSOLookup) Register(api huma.API) {
	huma.Register(api, Operation(api, huma.Operation{
		OperationID: "lookup-sso",
		Method:      http.MethodGet,
		Path:        AuthPrefix + "/sso/lookup",
		Summary:     "Is SSO used or enforced for an email's domain?",
		Description: "Public. The sign-in page calls it with the typed email before sending a code: when `enforced` is true it must skip the email code and send the browser to `start_url`. " +
			"Only the email's domain is looked up, never the account, so the answer reveals nothing about whether the address has an account; it reveals the display name of the organization that uses SSO for the domain, which that domain's sign-in page shows anyway. " +
			"Public email providers (gmail.com, outlook.com, …) never match. Rate-limited per client IP (429 `rate_limited` with Retry-After).",
		Tags:        []string{server.TagAuth},
		Middlewares: huma.Middlewares{s.limiter.Limit(api, "sso_lookup", s.perIP, ratelimit.Key{})},
	}, CodeInvalidRequest, CodeRateLimited, CodeInternal), s.lookup)
}

func (s *SSOLookup) lookup(ctx context.Context, in *SSOLookupInput) (*SSOLookupOutput, error) {
	addr, ok := NormalizeEmail(in.Email)
	if !ok {
		return nil, Err(CodeInvalidRequest)
	}
	domain := addr[strings.LastIndexByte(addr, '@')+1:]
	if IsPublicEmailDomain(domain) {
		return &SSOLookupOutput{}, nil
	}
	row, err := s.store.LookupOrgSSOForDomain(ctx, domain)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return &SSOLookupOutput{}, nil
	case err != nil:
		s.logger.ErrorContext(ctx, "sso lookup", "error", err)
		return nil, Err(CodeInternal)
	}
	return &SSOLookupOutput{Body: SSOLookupResponse{
		SSO:      true,
		Enforced: row.Enforce,
		OrgName:  row.Name,
		StartURL: s.issuer + AuthPrefix + "/sso/" + url.PathEscape(row.Slug) + "/start",
	}}, nil
}

// publicEmailDomains are consumer mailbox providers. Anyone can hold an
// address there, so no organization can claim them for SSO.
var publicEmailDomains = map[string]bool{
	"gmail.com": true, "googlemail.com": true,
	"outlook.com": true, "hotmail.com": true, "live.com": true, "msn.com": true, "passport.com": true,
	"yahoo.com": true, "ymail.com": true, "rocketmail.com": true,
	"icloud.com": true, "me.com": true, "mac.com": true,
	"aol.com": true, "aim.com": true,
	"proton.me": true, "protonmail.com": true, "protonmail.ch": true, "pm.me": true,
	"tutanota.com": true, "tutanota.de": true, "tuta.io": true, "tuta.com": true,
	"gmx.com": true, "gmx.net": true, "gmx.de": true, "web.de": true, "mail.com": true,
	"yandex.com": true, "yandex.ru": true, "ya.ru": true, "mail.ru": true, "bk.ru": true, "inbox.ru": true, "list.ru": true,
	"zoho.com": true, "zohomail.com": true, "fastmail.com": true, "fastmail.fm": true, "hey.com": true,
	"qq.com": true, "163.com": true, "126.com": true, "yeah.net": true, "sina.com": true, "foxmail.com": true,
	"naver.com": true, "daum.net": true, "hanmail.net": true,
	"rediffmail.com": true, "seznam.cz": true, "wp.pl": true, "o2.pl": true, "interia.pl": true,
	"libero.it": true, "virgilio.it": true, "orange.fr": true, "free.fr": true, "laposte.net": true, "sfr.fr": true,
	"t-online.de": true, "freenet.de": true, "bluewin.ch": true, "btinternet.com": true, "comcast.net": true,
	"att.net": true, "verizon.net": true, "sbcglobal.net": true, "cox.net": true, "earthlink.net": true,
	"duck.com": true, "mailbox.org": true, "posteo.de": true, "hushmail.com": true, "inbox.com": true,
}

// publicEmailBrands are providers that also hand out addresses under country
// domains (yahoo.co.uk, hotmail.fr, outlook.de, gmx.at, …).
var publicEmailBrands = map[string]bool{
	"gmail": true, "googlemail": true, "yahoo": true, "ymail": true, "hotmail": true, "outlook": true,
	"live": true, "msn": true, "aol": true, "gmx": true, "yandex": true, "icloud": true, "protonmail": true,
}

// IsPublicEmailDomain reports whether domain (lower-case, no "@") belongs to
// a consumer mailbox provider, such as gmail.com or yahoo.co.uk. An
// organization never gets SSO for such a domain.
func IsPublicEmailDomain(domain string) bool {
	domain = strings.TrimSuffix(strings.ToLower(domain), ".")
	if publicEmailDomains[domain] {
		return true
	}
	brand, suffix, ok := strings.Cut(domain, ".")
	if !ok || !publicEmailBrands[brand] {
		return false
	}
	// A country suffix: one or two short labels (fr, co.uk, com.br).
	labels := strings.Split(suffix, ".")
	if len(labels) > 2 {
		return false
	}
	for _, l := range labels {
		if l == "" || len(l) > 3 {
			return false
		}
	}
	return true
}
