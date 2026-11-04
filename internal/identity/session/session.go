// Package session owns identity's refresh-token sessions: it starts a
// session at sign-in, rotates its refresh token on every refresh and ends it
// at logout. Every sign-in method finishes with Service.Create.
//
// A refresh token is 32 random bytes, base64url-encoded; only its SHA-256 is
// stored (sessions.token_hash). Each refresh rotates: the presented row is
// revoked with reason "rotated" and a child row with a new token joins the
// same family. Presenting a rotated token again is reuse, a sign that the
// token was stolen: the whole family is revoked and session.reuse_detected
// is audited, so neither the thief nor the victim can refresh any more.
//
// A sign-in from a device the user has not used lately enqueues a new_signin
// email (see Create).
//
// Raw refresh tokens never reach a log: Tokens redacts them in its LogValue,
// and the service logs only session and family ids.
package session

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net/netip"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"

	"github.com/apilens/apilens/internal/email"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/identity/store/db"
)

// Revocation reasons stored in sessions.revoked_reason.
const (
	// ReasonRotated marks a row replaced by its child on refresh. It is
	// written by the RotateSession query itself.
	ReasonRotated = "rotated"
	// ReasonLogout marks a family ended by logout.
	ReasonLogout = "logout"
	// ReasonReuse marks a family revoked because a rotated token was
	// presented again.
	ReasonReuse = "reuse_detected"
	// ReasonUserDeleted marks a family ended because its user was deleted.
	ReasonUserDeleted = "user_deleted"
	// ReasonEmailChanged marks a family signed out because its user changed
	// their email from another session.
	ReasonEmailChanged = "email_changed"
)

// tokenBytes is the entropy of a refresh token (256 bits).
const tokenBytes = 32

// maxTokenLen bounds the raw token accepted for hashing; a valid one is 43
// characters.
const maxTokenLen = 512

var (
	// ErrInvalidToken means the refresh token is malformed or unknown.
	ErrInvalidToken = errors.New("session: invalid refresh token")
	// ErrReuseDetected means a rotated refresh token was presented again; its
	// family has been revoked. It wraps ErrInvalidToken.
	ErrReuseDetected = fmt.Errorf("%w: reuse detected", ErrInvalidToken)
	// ErrExpired means the session existed but has expired or was ended
	// (logout, revocation, deleted user).
	ErrExpired = errors.New("session: expired or revoked")
)

// AccessIssuer signs access tokens; *token.Issuer satisfies it.
type AccessIssuer interface {
	Issue(user db.User, session db.Session, amr []string) (string, time.Time, error)
}

// KnownDeviceWindow is how long after a session ends (it was revoked or
// rotated) its device still counts as known: signing in again from it within
// the window sends no new-sign-in alert.
const KnownDeviceWindow = 30 * 24 * time.Hour

// JobEnqueuer enqueues background jobs; *jobs.Client satisfies it.
type JobEnqueuer interface {
	Insert(ctx context.Context, args river.JobArgs, opts *river.InsertOpts) (*rivertype.JobInsertResult, error)
}

// TxBeginner starts transactions; *pgxpool.Pool satisfies it.
type TxBeginner interface {
	db.DBTX
	Begin(ctx context.Context) (pgx.Tx, error)
}

// Options configures a Service.
type Options struct {
	// RefreshTTL is the refresh-token lifetime with "remember me":
	// identity.refresh_token_ttl.
	RefreshTTL time.Duration
	// RefreshTTLShort is the lifetime without it:
	// identity.refresh_token_ttl_short.
	RefreshTTLShort time.Duration
	// Now returns the current time. Nil means time.Now.
	Now func() time.Time
	// Jobs enqueues the new_signin alert email. Nil sends no alerts.
	Jobs JobEnqueuer
}

// Service creates, rotates and ends sessions.
type Service struct {
	pool   TxBeginner
	q      *db.Queries
	issuer AccessIssuer
	audit  *audit.Recorder
	opts   Options
	logger *slog.Logger
}

// New returns a Service over pool that signs access tokens with issuer.
func New(pool TxBeginner, issuer AccessIssuer, opts Options, logger *slog.Logger) (*Service, error) {
	if opts.RefreshTTL <= 0 || opts.RefreshTTLShort <= 0 {
		return nil, errors.New("session: refresh TTLs must be > 0")
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Service{
		pool:   pool,
		q:      db.New(pool),
		issuer: issuer,
		audit:  audit.New(pool),
		opts:   opts,
		logger: logger,
	}, nil
}

// Meta describes how and from where a session was started.
type Meta struct {
	// AMR lists how the user authenticated (token.AMR* values).
	AMR []string
	// IP and UserAgent identify the client. When IP is invalid and
	// UserAgent empty, the request client in the context (audit.Middleware)
	// is used. The user agent is stored truncated to MaxUserAgentLen.
	IP        netip.Addr
	UserAgent string
	// DeviceLabel is a human-readable device name for the sessions list.
	// Empty means derived from the user agent (see DeviceLabel).
	DeviceLabel string
}

// Tokens is the outcome of a sign-in or refresh. Its LogValue redacts both
// tokens.
type Tokens struct {
	AccessToken     string
	AccessExpiresAt time.Time
	// RefreshToken is the raw refresh token; it is returned once and never
	// stored.
	RefreshToken string
	Session      db.Session
	User         db.User
}

// LogValue keeps the tokens out of logs.
func (t Tokens) LogValue() slog.Value {
	return slog.GroupValue(
		slog.String("user_id", t.User.ID.String()),
		slog.String("session_id", t.Session.ID.String()),
		slog.String("family_id", t.Session.FamilyID.String()),
	)
}

// Create starts a new session family for user and returns its refresh token
// and a first access token whose `sid` is the session row id.
//
// When no live session of the user, and none ended within
// KnownDeviceWindow, has the same device label and an IP in the same /24
// (IPv4) or /64 (IPv6), Create enqueues a new_signin email to the user. The
// user's very first sign-in (no session row at all, as right after
// user.created) sends none. Failing to check or enqueue is logged, never
// returned: the alert must not block the sign-in.
func (s *Service) Create(ctx context.Context, user db.User, remember bool, meta Meta) (Tokens, error) {
	raw, hash, err := newToken()
	if err != nil {
		return Tokens{}, err
	}
	ip, ua := client(ctx, meta.IP, meta.UserAgent)
	label := meta.DeviceLabel
	if label == "" {
		label = DeviceLabel(ua)
	}
	alert := s.newDevice(ctx, user.ID, label, ip)
	id := uuid.New()
	sess, err := s.q.CreateSession(ctx, db.CreateSessionParams{
		ID:          id,
		UserID:      user.ID,
		FamilyID:    id,
		TokenHash:   hash,
		Remember:    remember,
		Amr:         meta.AMR,
		Ip:          ip,
		UserAgent:   ua,
		DeviceLabel: label,
		ExpiresAt:   s.expiry(remember),
	})
	if err != nil {
		return Tokens{}, fmt.Errorf("session: create: %w", err)
	}
	if alert {
		s.alertNewSignIn(ctx, user, sess)
	}
	return s.tokens(user, sess, raw)
}

// newDevice reports whether a sign-in of user from label and ip should send
// a new_signin alert. Run it before the session row is created.
func (s *Service) newDevice(ctx context.Context, user uuid.UUID, label string, ip *netip.Addr) bool {
	if s.opts.Jobs == nil {
		return false
	}
	h, err := s.q.SignInHistory(ctx, db.SignInHistoryParams{
		UserID:       user,
		DeviceLabel:  label,
		Prefix:       NetworkPrefix(ip),
		RevokedSince: s.opts.Now().Add(-KnownDeviceWindow),
	})
	if err != nil {
		s.logger.ErrorContext(ctx, "session: sign-in history; no new sign-in alert", "user_id", user, "error", err)
		return false
	}
	return h.HasSessions && !h.KnownDevice
}

// alertNewSignIn enqueues the new_signin email for sess.
func (s *Service) alertNewSignIn(ctx context.Context, user db.User, sess db.Session) {
	ip := "unknown"
	if sess.Ip != nil {
		ip = sess.Ip.String()
	}
	job := email.SendArgs{To: user.Email, Template: email.TemplateNewSignin, Data: map[string]any{
		"device": sess.DeviceLabel,
		"ip":     ip,
		"time":   sess.CreatedAt,
	}}
	if _, err := s.opts.Jobs.Insert(ctx, job, nil); err != nil {
		s.logger.ErrorContext(ctx, "session: enqueue new sign-in alert",
			"user_id", user.ID, "session_id", sess.ID, "error", err)
	}
}

// NetworkPrefix returns the network a sign-in from ip is compared by: its
// /24 for IPv4 (IPv4-mapped IPv6 included) and its /64 for IPv6, or nil
// when ip is unknown.
func NetworkPrefix(ip *netip.Addr) *netip.Prefix {
	if ip == nil || !ip.IsValid() {
		return nil
	}
	a := ip.Unmap().WithZone("")
	bits := 64
	if a.Is4() {
		bits = 24
	}
	p, err := a.Prefix(bits)
	if err != nil {
		return nil
	}
	return &p
}

// Refresh rotates the session of raw and returns a new refresh token and
// access token. It fails with ErrInvalidToken for an unknown token,
// ErrReuseDetected (after revoking the family) for a rotated one, and
// ErrExpired for an expired or ended session.
func (s *Service) Refresh(ctx context.Context, raw string) (Tokens, error) {
	sess, err := s.lookup(ctx, raw)
	if err != nil {
		return Tokens{}, err
	}
	if sess.RevokedAt != nil {
		if reasonIs(sess, ReasonRotated) {
			return Tokens{}, s.reuse(ctx, sess)
		}
		return Tokens{}, ErrExpired
	}
	if !sess.ExpiresAt.After(s.opts.Now()) {
		return Tokens{}, ErrExpired
	}
	user, err := s.q.GetUserByID(ctx, sess.UserID)
	if errors.Is(err, pgx.ErrNoRows) {
		// The user was deleted; end the family so it stops appearing live.
		if _, err := s.q.RevokeFamily(ctx, db.RevokeFamilyParams{Reason: ReasonUserDeleted, FamilyID: sess.FamilyID}); err != nil {
			return Tokens{}, fmt.Errorf("session: revoke family of deleted user: %w", err)
		}
		return Tokens{}, ErrExpired
	}
	if err != nil {
		return Tokens{}, fmt.Errorf("session: load user: %w", err)
	}

	next, hash, err := newToken()
	if err != nil {
		return Tokens{}, err
	}
	ip, ua := client(ctx, netip.Addr{}, "")
	child, err := s.q.RotateSession(ctx, db.RotateSessionParams{
		ID:        uuid.New(),
		ParentID:  sess.ID,
		TokenHash: hash,
		Ip:        ip,
		UserAgent: ua,
		ExpiresAt: s.expiry(sess.Remember),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		// The parent stopped being live since lookup: a concurrent refresh
		// rotated it (the token was presented twice), or it expired or was
		// revoked meanwhile. Classify its current state.
		cur, lerr := s.q.GetSessionByTokenHash(ctx, sess.TokenHash)
		if lerr != nil {
			return Tokens{}, fmt.Errorf("session: reload after failed rotation: %w", lerr)
		}
		if reasonIs(cur, ReasonRotated) {
			return Tokens{}, s.reuse(ctx, cur)
		}
		return Tokens{}, ErrExpired
	}
	if err != nil {
		return Tokens{}, fmt.Errorf("session: rotate: %w", err)
	}
	return s.tokens(user, child, next)
}

// Logout ends the session family of raw and audits session.revoked. An
// unknown, expired or already ended token is not an error, so logout is
// idempotent and reveals nothing. A rotated token is treated as reuse, as in
// Refresh, but Logout still succeeds.
func (s *Service) Logout(ctx context.Context, raw string) error {
	sess, err := s.lookup(ctx, raw)
	if errors.Is(err, ErrInvalidToken) {
		return nil
	}
	if err != nil {
		return err
	}
	if sess.RevokedAt != nil {
		if reasonIs(sess, ReasonRotated) {
			if err := s.reuse(ctx, sess); !errors.Is(err, ErrReuseDetected) {
				return err
			}
		}
		return nil
	}
	return s.inTx(ctx, func(ctx context.Context, q *db.Queries) error {
		n, err := q.RevokeFamily(ctx, db.RevokeFamilyParams{Reason: ReasonLogout, FamilyID: sess.FamilyID})
		if err != nil {
			return fmt.Errorf("session: logout: %w", err)
		}
		if n == 0 {
			return nil
		}
		return s.audit.Record(ctx, audit.Event{
			User:  &sess.UserID,
			Actor: &sess.UserID,
			Kind:  audit.SessionRevoked,
			Meta:  map[string]any{"session_id": sess.ID.String(), "family_id": sess.FamilyID.String(), "reason": ReasonLogout},
		})
	})
}

// Active is a live session of a user as the sessions list shows it.
type Active struct {
	db.Session
	// Current marks the session the caller is using: the family of the
	// access token's sid.
	Current bool
}

// List returns the live sessions of user (one per sign-in), most recently
// active first, flagging the one the caller uses. currentSID is the access
// token's sid; it may name a row rotated since the token was issued, so the
// match is by family, not by row id.
func (s *Service) List(ctx context.Context, user, currentSID uuid.UUID) ([]Active, error) {
	rows, err := s.q.ListActiveSessionsForUser(ctx, user)
	if err != nil {
		return nil, fmt.Errorf("session: list: %w", err)
	}
	var currentFamily uuid.UUID
	for _, r := range rows {
		if r.ID == currentSID {
			currentFamily = r.FamilyID
			break
		}
	}
	if currentFamily == uuid.Nil && currentSID != uuid.Nil {
		cur, err := s.q.GetSessionForUser(ctx, db.GetSessionForUserParams{ID: currentSID, UserID: user})
		switch {
		case err == nil:
			currentFamily = cur.FamilyID
		case !errors.Is(err, pgx.ErrNoRows):
			return nil, fmt.Errorf("session: load current: %w", err)
		}
	}
	out := make([]Active, len(rows))
	for i, r := range rows {
		out[i] = Active{Session: r, Current: currentFamily != uuid.Nil && r.FamilyID == currentFamily}
	}
	return out, nil
}

// reuse revokes the family of a replayed rotated token, audits
// session.reuse_detected and returns ErrReuseDetected.
func (s *Service) reuse(ctx context.Context, sess db.Session) error {
	var revoked int64
	err := s.inTx(ctx, func(ctx context.Context, q *db.Queries) error {
		n, err := q.RevokeFamily(ctx, db.RevokeFamilyParams{Reason: ReasonReuse, FamilyID: sess.FamilyID})
		if err != nil {
			return fmt.Errorf("session: revoke family on reuse: %w", err)
		}
		revoked = n
		return s.audit.Record(ctx, audit.Event{
			User: &sess.UserID,
			Kind: audit.SessionReuseDetected,
			Meta: map[string]any{"session_id": sess.ID.String(), "family_id": sess.FamilyID.String(), "revoked": n},
		})
	})
	if err != nil {
		return err
	}
	s.logger.WarnContext(ctx, "refresh token reuse detected; session family revoked",
		"user_id", sess.UserID, "session_id", sess.ID, "family_id", sess.FamilyID, "revoked", revoked)
	return ErrReuseDetected
}

// lookup returns the row of raw whatever its state, or ErrInvalidToken.
func (s *Service) lookup(ctx context.Context, raw string) (db.Session, error) {
	if !wellFormed(raw) {
		return db.Session{}, ErrInvalidToken
	}
	sess, err := s.q.GetSessionByTokenHash(ctx, Hash(raw))
	if errors.Is(err, pgx.ErrNoRows) {
		return db.Session{}, ErrInvalidToken
	}
	if err != nil {
		return db.Session{}, fmt.Errorf("session: lookup: %w", err)
	}
	return sess, nil
}

// tokens issues the access token for sess and assembles the result.
func (s *Service) tokens(user db.User, sess db.Session, raw string) (Tokens, error) {
	access, exp, err := s.issuer.Issue(user, sess, sess.Amr)
	if err != nil {
		return Tokens{}, fmt.Errorf("session: issue access token: %w", err)
	}
	return Tokens{AccessToken: access, AccessExpiresAt: exp, RefreshToken: raw, Session: sess, User: user}, nil
}

// inTx runs fn in a transaction whose audit events commit with it.
func (s *Service) inTx(ctx context.Context, fn func(context.Context, *db.Queries) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("session: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := fn(audit.WithTx(ctx, tx), s.q.WithTx(tx)); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("session: commit: %w", err)
	}
	return nil
}

func (s *Service) expiry(remember bool) time.Time {
	if remember {
		return s.opts.Now().Add(s.opts.RefreshTTL)
	}
	return s.opts.Now().Add(s.opts.RefreshTTLShort)
}

// client returns ip and ua, falling back to the context's request client;
// ua is truncated to MaxUserAgentLen.
func client(ctx context.Context, ip netip.Addr, ua string) (*netip.Addr, string) {
	if !ip.IsValid() && ua == "" {
		req := audit.RequestFrom(ctx)
		ip, ua = req.IP, req.UserAgent
	}
	ua = TruncateUserAgent(ua)
	if !ip.IsValid() {
		return nil, ua
	}
	return &ip, ua
}

func reasonIs(sess db.Session, reason string) bool {
	return sess.RevokedReason != nil && *sess.RevokedReason == reason
}

// newToken returns a fresh raw refresh token and its stored hash.
func newToken() (raw, hash string, err error) {
	b := make([]byte, tokenBytes)
	if _, err := rand.Read(b); err != nil {
		return "", "", fmt.Errorf("session: random token: %w", err)
	}
	raw = base64.RawURLEncoding.EncodeToString(b)
	return raw, Hash(raw), nil
}

// Hash returns the stored form of a raw refresh token: its SHA-256,
// base64url-encoded.
func Hash(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// wellFormed rejects values that cannot be a refresh token before hashing.
func wellFormed(raw string) bool {
	if raw == "" || len(raw) > maxTokenLen {
		return false
	}
	_, err := base64.RawURLEncoding.DecodeString(raw)
	return err == nil
}
