package identity

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"

	"github.com/apilens/apilens/internal/email"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/emailauth"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/ratelimit"
	"github.com/apilens/apilens/internal/platform/server"
)

// EmailResendCooldown is how long after one sign-in email another one for the
// same address and intent is not sent. Requests inside it still answer 200,
// with the remaining wait as retry_after.
const EmailResendCooldown = 30 * time.Second

// maxEmailLen is the longest address accepted (RFC 5321 path limit).
const maxEmailLen = 254

// maxEmailNextLen matches the auth_email_tokens.next_path check.
const maxEmailNextLen = 512

// EmailTokens issues sign-in emails; *emailauth.Service satisfies it.
type EmailTokens interface {
	Issue(ctx context.Context, email string, intent emailauth.Intent, opts emailauth.IssueOptions) (emailauth.Issued, error)
	Latest(ctx context.Context, email string) (db.AuthEmailToken, bool, error)
}

// UserLookup finds an active user by email (case-insensitive); *db.Queries
// satisfies it.
type UserLookup interface {
	GetUserByEmail(ctx context.Context, email string) (db.User, error)
}

// JobEnqueuer enqueues background jobs; *jobs.Client satisfies it.
type JobEnqueuer interface {
	Insert(ctx context.Context, args river.JobArgs, opts *river.InsertOpts) (*rivertype.JobInsertResult, error)
}

// AuditRecorder records audit events; *audit.Recorder satisfies it.
type AuditRecorder interface {
	Record(ctx context.Context, e audit.Event) error
}

// EmailStartDeps are the collaborators of the email-start endpoint.
type EmailStartDeps struct {
	Tokens EmailTokens
	Users  UserLookup
	Jobs   JobEnqueuer
	Audit  AuditRecorder
	// SSO refuses addresses whose organization enforces single sign-on
	// (sso_required). Nil checks nothing.
	SSO *SSOEnforcement
}

// EmailStartBody is the request body of POST /api/v1/auth/email/start.
type EmailStartBody struct {
	Email    string `json:"email" format:"email" minLength:"3" maxLength:"254" doc:"Address to email the sign-in code and link to."`
	Intent   string `json:"intent" enum:"signin,signup" doc:"signin for an existing account, signup to create one. Either way an existing account is signed in."`
	Next     string `json:"next,omitempty" maxLength:"512" doc:"Relative path (starting with a single /) to open after sign-in."`
	Remember bool   `json:"remember,omitempty" doc:"Accepted for symmetry with the UI form; the session lifetime is chosen when the code or link is verified."`
}

// EmailStartInput is the request of POST /api/v1/auth/email/start.
type EmailStartInput struct {
	Body EmailStartBody
}

// EmailStartResponse is the body of every successful email-start answer,
// whether or not the address has an account.
type EmailStartResponse struct {
	Sent       bool `json:"sent" doc:"Always true; the response never reveals whether an account exists."`
	RetryAfter int  `json:"retry_after" minimum:"1" doc:"Seconds before another email can be requested."`
}

// EmailStartOutput is the response of POST /api/v1/auth/email/start.
type EmailStartOutput struct {
	Body EmailStartResponse
}

// EmailStart serves POST /api/v1/auth/email/start.
type EmailStart struct {
	deps     EmailStartDeps
	limiter  *ratelimit.Limiter
	perIP    ratelimit.Rate
	perEmail ratelimit.Rate
	logger   *slog.Logger
	now      func() time.Time
}

// NewEmailStart returns the email-start endpoint. limiter enforces
// identity.rate_limits.email_start_per_ip and email_start_per_email.
func NewEmailStart(cfg config.IdentityConfig, deps EmailStartDeps, limiter *ratelimit.Limiter, logger *slog.Logger) *EmailStart {
	return &EmailStart{
		deps:     deps,
		limiter:  limiter,
		perIP:    ratelimit.Rate(cfg.RateLimits.EmailStartPerIP),
		perEmail: ratelimit.Rate(cfg.RateLimits.EmailStartPerEmail),
		logger:   logger,
		now:      time.Now,
	}
}

// Register mounts POST /api/v1/auth/email/start.
func (e *EmailStart) Register(api huma.API) {
	huma.Register(api, Operation(api, huma.Operation{
		OperationID: "start-email-sign-in",
		Method:      http.MethodPost,
		Path:        AuthPrefix + "/email/start",
		Summary:     "Email a sign-in code and link",
		Description: "Public. Emails a 6-digit code and a magic link (15 minutes, single use) to the address. " +
			"Always answers 200 `{sent: true, retry_after}` whether or not the address has an account; " +
			"for `intent=signin` with no account the email offers sign-up instead. " +
			"Within 30 seconds of the previous email for the same address and intent no new email is sent and `retry_after` is the remaining wait. " +
			"An address at a domain whose organization enforces single sign-on gets 403 `sso_required` with the organization's `start_url` and no email (decided by the domain alone, so it reveals nothing about the account). " +
			"Rate-limited per client IP and per email address (429 `rate_limited` with Retry-After).",
		Tags:        []string{server.TagAuth},
		Middlewares: huma.Middlewares{e.limiter.Limit(api, "email_start", e.perIP, ratelimit.Key{})},
	}, CodeInvalidRequest, CodeSSORequired, CodeRateLimited, CodeInternal), e.start)
}

func (e *EmailStart) start(ctx context.Context, in *EmailStartInput) (*EmailStartOutput, error) {
	addr, ok := NormalizeEmail(in.Body.Email)
	if !ok {
		return nil, Err(CodeInvalidRequest)
	}
	intent := emailauth.Intent(in.Body.Intent)
	if intent != emailauth.IntentSignIn && intent != emailauth.IntentSignUp {
		return nil, Err(CodeInvalidRequest)
	}
	var next *string
	if in.Body.Next != "" {
		n, ok := SafeNext(in.Body.Next)
		if !ok || len(n) > maxEmailNextLen {
			return nil, Err(CodeInvalidRequest)
		}
		next = &n
	}

	startURL, required, err := e.deps.SSO.Required(ctx, addr)
	if err != nil {
		e.logger.ErrorContext(ctx, "email start: sso enforcement", "error", err)
		return nil, Err(CodeInternal)
	}
	if required {
		return nil, ErrSSORequired(startURL)
	}

	res, err := e.limiter.Allow(ctx, "email_start:email", addr, e.perEmail)
	if err != nil {
		e.logger.ErrorContext(ctx, "email start: rate limiter unavailable; refusing", "error", err)
		return nil, huma.Error503ServiceUnavailable("rate limiter unavailable, retry later")
	}
	if !res.Allowed {
		return nil, ErrRetryAfter(CodeRateLimited, res.RetryAfter)
	}

	user, err := e.deps.Users.GetUserByEmail(ctx, addr)
	var userID *uuid.UUID
	switch {
	case err == nil:
		userID = &user.ID
	case errors.Is(err, pgx.ErrNoRows):
	default:
		e.logger.ErrorContext(ctx, "email start: look up user", "error", err)
		return nil, Err(CodeInternal)
	}

	// Resend cooldown: the same answer either way, but no second email.
	latest, found, err := e.deps.Tokens.Latest(ctx, addr)
	if err != nil {
		e.logger.ErrorContext(ctx, "email start: latest email", "error", err)
		return nil, Err(CodeInternal)
	}
	if found && latest.Intent == string(intent) {
		// Issue sets expires_at from this process's clock (created_at is the
		// database's), so the issue time is derived from it to compare like
		// with like.
		issuedAt := latest.ExpiresAt.Add(-emailauth.TTL)
		if wait := min(issuedAt.Add(EmailResendCooldown).Sub(e.now()), EmailResendCooldown); wait > 0 {
			e.record(ctx, userID, addr, intent, false)
			return startOutput(wait), nil
		}
	}

	req := audit.RequestFrom(ctx)
	opts := emailauth.IssueOptions{UserID: userID, NextPath: next, UserAgent: req.UserAgent}
	if req.IP.IsValid() {
		ip := req.IP
		opts.IP = &ip
	}
	// A row is issued for an unknown address too, so the cooldown and the
	// work done (and so the latency) do not depend on whether it has an
	// account. Nobody receives that row's code or link.
	issued, err := e.deps.Tokens.Issue(ctx, addr, intent, opts)
	if err != nil {
		e.logger.ErrorContext(ctx, "email start: issue", "error", err)
		return nil, Err(CodeInternal)
	}

	job := email.SendArgs{To: addr, Template: email.TemplateAuthCode, Data: map[string]any{
		"code":       issued.Code,
		"token":      issued.LinkToken,
		"email":      addr,
		"expires_in": fmt.Sprintf("%d minutes", int(emailauth.TTL/time.Minute)),
	}}
	if userID == nil && intent == emailauth.IntentSignIn {
		job = email.SendArgs{To: addr, Template: email.TemplateAuthNoAccount, Data: map[string]any{"email": addr}}
	}
	if _, err := e.deps.Jobs.Insert(ctx, job, nil); err != nil {
		e.logger.ErrorContext(ctx, "email start: enqueue email", "error", err)
		return nil, Err(CodeInternal)
	}
	e.record(ctx, userID, addr, intent, true)
	return startOutput(EmailResendCooldown), nil
}

// record audits login.requested. A failure is logged, not returned: the
// email is already on its way.
func (e *EmailStart) record(ctx context.Context, userID *uuid.UUID, addr string, intent emailauth.Intent, sent bool) {
	err := e.deps.Audit.Record(ctx, audit.Event{
		User: userID,
		Kind: audit.LoginRequested,
		Meta: map[string]any{"method": "email", "intent": string(intent), "email": addr, "email_sent": sent},
	})
	if err != nil {
		e.logger.ErrorContext(ctx, "email start: audit", "error", err)
	}
}

func startOutput(wait time.Duration) *EmailStartOutput {
	return &EmailStartOutput{Body: EmailStartResponse{
		Sent:       true,
		RetryAfter: max(1, int(math.Ceil(wait.Seconds()))),
	}}
}

// NormalizeEmail checks that s is a bare email address (no display name,
// comments or quoting) with a dotted domain, and returns it trimmed and
// lower-cased so one address maps to one bucket, row and account.
func NormalizeEmail(s string) (string, bool) {
	s = strings.TrimSpace(s)
	if s == "" || len(s) > maxEmailLen {
		return "", false
	}
	a, err := mail.ParseAddress(s)
	if err != nil || a.Name != "" || a.Address != s {
		return "", false
	}
	at := strings.LastIndexByte(s, '@')
	domain := s[at+1:]
	if at < 1 || !strings.Contains(domain, ".") || strings.HasPrefix(domain, ".") || strings.HasSuffix(domain, ".") {
		return "", false
	}
	return strings.ToLower(s), true
}
