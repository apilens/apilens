package identity

// Connected accounts: linking a Google or GitHub account to the signed-in
// user (GET …/oauth/{provider}/start?intent=link, then the callback), listing
// the linked accounts (GET /api/v1/users/me/identities) and unlinking one
// (DELETE /api/v1/users/me/identities/{id}). Email is always a sign-in
// method, so any linked account, the last one included, can be unlinked.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/apilens/apilens/internal/email"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/session"
	"github.com/apilens/apilens/internal/identity/store/db"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/server"
)

// MyIdentitiesPath is the connected provider accounts of the signed-in user.
const MyIdentitiesPath = server.APIPrefix + "/users/me/identities"

// CodeOAuthIdentityTaken is the `?error=` the callback of an intent=link
// flow sends the browser back to the sign-in page with when the provider
// account is already linked to another user. Like CodeOAuthDenied it is a
// redirect-only code.
const CodeOAuthIdentityTaken = "oauth_identity_taken"

var (
	// ErrOAuthIdentityTaken means the provider account is linked to another
	// user.
	ErrOAuthIdentityTaken = errors.New("identity: oauth identity linked to another user")
	// ErrOAuthIdentityNotFound means the user has no linked identity with
	// that id (it never existed, was unlinked, or belongs to another user).
	ErrOAuthIdentityNotFound = errors.New("identity: oauth identity not found")
	// ErrOAuthLinkUserGone means the user the link was started for no longer
	// exists (deleted while the flow was at the provider).
	ErrOAuthLinkUserGone = errors.New("identity: oauth link user not found")
)

// OAuthIdentities lists, links and unlinks a user's provider accounts;
// *PGOAuthIdentities satisfies it.
type OAuthIdentities interface {
	// List returns user's linked identities, oldest first.
	List(ctx context.Context, user uuid.UUID) ([]db.OauthIdentity, error)
	// Link attaches ext to user and audits oauth.linked. linked is false
	// when ext was already linked to user (nothing changes). It returns
	// ErrOAuthIdentityTaken when ext is linked to another user and
	// ErrOAuthLinkUserGone when user does not exist.
	Link(ctx context.Context, user uuid.UUID, ext ExternalIdentity) (u db.User, linked bool, err error)
	// Unlink removes user's identity id and audits oauth.unlinked. It
	// returns ErrOAuthIdentityNotFound when user has no such identity.
	Unlink(ctx context.Context, user, id uuid.UUID) (db.User, db.OauthIdentity, error)
}

// PGOAuthIdentities is the Postgres OAuthIdentities.
type PGOAuthIdentities struct {
	pool  TxBeginner
	q     *db.Queries
	audit *audit.Recorder
}

// NewPGOAuthIdentities returns the Postgres OAuthIdentities over pool.
func NewPGOAuthIdentities(pool TxBeginner) *PGOAuthIdentities {
	return &PGOAuthIdentities{pool: pool, q: db.New(pool), audit: audit.New(pool)}
}

// List implements OAuthIdentities.
func (s *PGOAuthIdentities) List(ctx context.Context, user uuid.UUID) ([]db.OauthIdentity, error) {
	ids, err := s.q.ListOAuthIdentitiesForUser(ctx, user)
	if err != nil {
		return nil, fmt.Errorf("identity: list oauth identities: %w", err)
	}
	return ids, nil
}

// errLinkRaced means a concurrent link of the same provider account won the
// insert; the link is retried once to report what it now is.
var errLinkRaced = errors.New("identity: oauth link raced")

// Link implements OAuthIdentities.
func (s *PGOAuthIdentities) Link(ctx context.Context, user uuid.UUID, ext ExternalIdentity) (db.User, bool, error) {
	profile, err := json.Marshal(ext.Profile)
	if err != nil {
		return db.User{}, false, fmt.Errorf("identity: encode oauth profile: %w", err)
	}
	for attempt := 0; ; attempt++ {
		var (
			u      db.User
			linked bool
		)
		err := s.inTx(ctx, func(ctx context.Context, q *db.Queries) error {
			var err error
			u, err = q.GetUserByID(ctx, user)
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrOAuthLinkUserGone
			}
			if err != nil {
				return fmt.Errorf("identity: load link user: %w", err)
			}
			existing, err := q.GetOAuthIdentityByProviderSubject(ctx, db.GetOAuthIdentityByProviderSubjectParams{Provider: ext.Provider, Subject: ext.Subject})
			switch {
			case err == nil && existing.UserID == user:
				return nil
			case err == nil:
				return ErrOAuthIdentityTaken
			case !errors.Is(err, pgx.ErrNoRows):
				return fmt.Errorf("identity: look up oauth identity: %w", err)
			}
			var addr *string
			if ext.Email != "" {
				addr = &ext.Email
			}
			row, err := q.CreateOAuthIdentity(ctx, db.CreateOAuthIdentityParams{
				ID:       uuid.New(),
				UserID:   user,
				Provider: ext.Provider,
				Subject:  ext.Subject,
				Email:    addr,
				Profile:  profile,
			})
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23505" {
				return errLinkRaced
			}
			if err != nil {
				return fmt.Errorf("identity: link oauth identity: %w", err)
			}
			linked = true
			return s.audit.Record(ctx, audit.Event{
				User:  &user,
				Actor: &user,
				Kind:  audit.OAuthLinked,
				Meta: map[string]any{
					"identity_id": row.ID.String(),
					"provider":    row.Provider,
					"subject":     row.Subject,
				},
			})
		})
		if errors.Is(err, errLinkRaced) && attempt == 0 {
			continue
		}
		if err != nil {
			return db.User{}, false, err
		}
		return u, linked, nil
	}
}

// Unlink implements OAuthIdentities.
func (s *PGOAuthIdentities) Unlink(ctx context.Context, user, id uuid.UUID) (db.User, db.OauthIdentity, error) {
	var (
		u     db.User
		ident db.OauthIdentity
	)
	err := s.inTx(ctx, func(ctx context.Context, q *db.Queries) error {
		var err error
		u, err = q.GetUserByID(ctx, user)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrOAuthIdentityNotFound
		}
		if err != nil {
			return fmt.Errorf("identity: load user: %w", err)
		}
		ids, err := q.ListOAuthIdentitiesForUser(ctx, user)
		if err != nil {
			return fmt.Errorf("identity: list oauth identities: %w", err)
		}
		found := false
		for _, i := range ids {
			if i.ID == id {
				ident, found = i, true
				break
			}
		}
		if !found {
			return ErrOAuthIdentityNotFound
		}
		n, err := q.DeleteOAuthIdentity(ctx, db.DeleteOAuthIdentityParams{ID: id, UserID: user})
		if err != nil {
			return fmt.Errorf("identity: unlink oauth identity: %w", err)
		}
		if n == 0 {
			return ErrOAuthIdentityNotFound
		}
		return s.audit.Record(ctx, audit.Event{
			User:  &user,
			Actor: &user,
			Kind:  audit.OAuthUnlinked,
			Meta: map[string]any{
				"identity_id": ident.ID.String(),
				"provider":    ident.Provider,
				"subject":     ident.Subject,
			},
		})
	})
	if err != nil {
		return db.User{}, db.OauthIdentity{}, err
	}
	return u, ident, nil
}

// inTx runs fn in a transaction whose audit events commit with it.
func (s *PGOAuthIdentities) inTx(ctx context.Context, fn func(context.Context, *db.Queries) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("identity: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := fn(audit.WithTx(ctx, tx), s.q.WithTx(tx)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("identity: commit: %w", err)
	}
	return nil
}

// linkIdentity finishes an intent=link callback: it attaches ext to the user
// the flow was started by and returns the UI path to land on.
func (o *OAuth) linkIdentity(ctx context.Context, ext ExternalIdentity, st OAuthState) (string, error) {
	d := o.signIn
	if d.Identities == nil || d.Jobs == nil {
		return "", failure(CodeInternal, "not_configured", errors.New("oauth link collaborators not set"))
	}
	uid, err := uuid.Parse(st.LinkUserID)
	if err != nil {
		return "", failure(CodeInternal, "link_user", err)
	}
	u, linked, err := d.Identities.Link(ctx, uid, ext)
	switch {
	case errors.Is(err, ErrOAuthIdentityTaken):
		return "", &callbackFailure{code: CodeOAuthIdentityTaken, reason: "identity_taken"}
	case errors.Is(err, ErrOAuthLinkUserGone):
		return "", failure(CodeSessionExpired, "link_user_gone", nil)
	case err != nil:
		return "", failure(CodeInternal, "link_identity", err)
	}
	if linked {
		// The link is committed; a failed alert is logged, not returned.
		securityAlert(ctx, d.Jobs, o.logger, u.Email, email.SecurityChangeOAuthLinked, o.now())
	}
	return withQuery(st.Next, "linked", ext.Provider), nil
}

// withQuery adds key=value to the query of the relative path next.
func withQuery(next, key, value string) string {
	u, err := url.Parse(next)
	if err != nil {
		return next
	}
	q := u.Query()
	q.Set(key, value)
	u.RawQuery = q.Encode()
	return u.String()
}

// securityAlert enqueues a security_change email of change to to. A failure
// is logged: the change it reports is already committed.
func securityAlert(ctx context.Context, jobs JobEnqueuer, logger *slog.Logger, to, change string, now time.Time) {
	req := audit.RequestFrom(ctx)
	ip := "unknown"
	if req.IP.IsValid() {
		ip = req.IP.String()
	}
	job := email.SendArgs{To: to, Template: email.TemplateSecurityChange, Data: map[string]any{
		"change": change,
		"device": session.DeviceLabel(req.UserAgent),
		"ip":     ip,
		"time":   now.UTC(),
	}}
	if _, err := jobs.Insert(ctx, job, nil); err != nil {
		logger.ErrorContext(ctx, "enqueue security alert", "change", change, "error", err)
	}
}

// ConnectedAccountsDeps are the collaborators of the connected-account
// endpoints.
type ConnectedAccountsDeps struct {
	Identities OAuthIdentities
	Jobs       JobEnqueuer
}

// ConnectedAccount is one linked provider account as listed in Settings →
// Connected accounts.
type ConnectedAccount struct {
	ID          string     `json:"id" format:"uuid"`
	Provider    string     `json:"provider" enum:"google,github"`
	Email       *string    `json:"email" nullable:"true" doc:"Address the provider reported, or null."`
	Name        string     `json:"name" doc:"Display name at the provider, or empty."`
	Username    string     `json:"username" doc:"Login at the provider (GitHub), or empty."`
	AvatarURL   string     `json:"avatar_url" doc:"Avatar at the provider, or empty."`
	CreatedAt   time.Time  `json:"created_at" doc:"When the account was connected."`
	LastLoginAt *time.Time `json:"last_login_at" nullable:"true" doc:"Last sign-in through this account, or null."`
}

// NewConnectedAccount renders i.
func NewConnectedAccount(i db.OauthIdentity) ConnectedAccount {
	var p map[string]any
	_ = json.Unmarshal(i.Profile, &p)
	str := func(keys ...string) string {
		for _, k := range keys {
			if v, ok := p[k].(string); ok && v != "" {
				return v
			}
		}
		return ""
	}
	a := ConnectedAccount{
		ID:        i.ID.String(),
		Provider:  i.Provider,
		Email:     i.Email,
		Name:      str("name"),
		Username:  str("login"),
		AvatarURL: str("avatar_url", "picture"),
		CreatedAt: i.CreatedAt.UTC(),
	}
	if i.LastLoginAt != nil {
		t := i.LastLoginAt.UTC()
		a.LastLoginAt = &t
	}
	return a
}

// ListMyIdentitiesOutput is the response of GET /api/v1/users/me/identities.
type ListMyIdentitiesOutput struct {
	Body struct {
		Identities []ConnectedAccount `json:"identities" doc:"The user's connected provider accounts, oldest first."`
	}
}

// IdentityIDInput names one connected account of the signed-in user.
type IdentityIDInput struct {
	ID string `path:"id" format:"uuid" doc:"Connected account id."`
}

// ConnectedAccounts serves the connected-account endpoints.
type ConnectedAccounts struct {
	deps   ConnectedAccountsDeps
	logger *slog.Logger
	now    func() time.Time
}

// NewConnectedAccounts returns the connected-account endpoints.
func NewConnectedAccounts(deps ConnectedAccountsDeps, logger *slog.Logger) *ConnectedAccounts {
	return &ConnectedAccounts{deps: deps, logger: logger, now: time.Now}
}

// Register mounts GET /api/v1/users/me/identities and DELETE …/{id}. They
// declare the session scheme, so authn.Middleware must be installed on api
// before.
func (c *ConnectedAccounts) Register(api huma.API) {
	security := []map[string][]string{{authn.SchemeSession: {}}}
	huma.Register(api, Operation(api, huma.Operation{
		OperationID: "list-my-identities",
		Method:      http.MethodGet,
		Path:        MyIdentitiesPath,
		Summary:     "List my connected accounts",
		Description: "Lists the Google and GitHub accounts connected to the signed-in user, oldest first. " +
			"Connect one with `GET /api/v1/auth/oauth/{provider}/start?intent=link`.",
		Tags:     []string{server.TagUsers},
		Security: security,
	}, CodeUnauthenticated, CodeSessionExpired, CodeInternal), c.list)

	huma.Register(api, Operation(api, huma.Operation{
		OperationID: "delete-my-identity",
		Method:      http.MethodDelete,
		Path:        MyIdentitiesPath + "/{id}",
		Summary:     "Disconnect an account",
		Description: "Disconnects one of the signed-in user's Google or GitHub accounts; it can no longer be used to sign in. " +
			"Email always remains a sign-in method, so the last connected account can be disconnected too. " +
			"Answers 410 `oauth_identity_gone` for an id that is not one of the user's connected accounts. " +
			"Audited as `oauth.unlinked`; the user is emailed a security alert.",
		Tags:          []string{server.TagUsers},
		Security:      security,
		DefaultStatus: http.StatusNoContent,
	}, CodeUnauthenticated, CodeSessionExpired, CodeOAuthIdentityGone, CodeInternal), c.remove)
}

func (c *ConnectedAccounts) list(ctx context.Context, _ *struct{}) (*ListMyIdentitiesOutput, error) {
	p, ok := authn.FromContext(ctx)
	if !ok || p.Kind != authn.KindUser {
		return nil, Err(CodeUnauthenticated)
	}
	ids, err := c.deps.Identities.List(ctx, p.UserID)
	if err != nil {
		c.logger.ErrorContext(ctx, "list oauth identities", "error", err)
		return nil, Err(CodeInternal)
	}
	out := &ListMyIdentitiesOutput{}
	out.Body.Identities = make([]ConnectedAccount, len(ids))
	for i, id := range ids {
		out.Body.Identities[i] = NewConnectedAccount(id)
	}
	return out, nil
}

func (c *ConnectedAccounts) remove(ctx context.Context, in *IdentityIDInput) (*struct{}, error) {
	p, ok := authn.FromContext(ctx)
	if !ok || p.Kind != authn.KindUser {
		return nil, Err(CodeUnauthenticated)
	}
	id, err := uuid.Parse(in.ID)
	if err != nil {
		return nil, Err(CodeOAuthIdentityGone)
	}
	u, _, err := c.deps.Identities.Unlink(ctx, p.UserID, id)
	switch {
	case err == nil:
	case errors.Is(err, ErrOAuthIdentityNotFound):
		return nil, Err(CodeOAuthIdentityGone)
	default:
		c.logger.ErrorContext(ctx, "unlink oauth identity", "error", err)
		return nil, Err(CodeInternal)
	}
	securityAlert(ctx, c.deps.Jobs, c.logger, u.Email, email.SecurityChangeOAuthUnlinked, c.now())
	return nil, nil
}
