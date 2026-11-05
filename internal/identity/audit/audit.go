// Package audit records security-relevant account events in audit_events,
// for users (and later admins) to inspect.
//
// Callers record an event with Recorder.Record. The client IP and user agent
// are not passed in: Middleware captures them from the HTTP request into the
// context, so every event recorded while serving a request carries them. When
// the caller runs inside a transaction (WithTx), the event is written in that
// transaction and is committed or rolled back with the change it describes.
package audit

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"slices"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/identity/store/db"
)

// Kind is the stable name of an audit event, stored in audit_events.event.
// A kind never changes once shipped; docs/architecture/overview.md lists
// every kind (a test checks).
type Kind string

// The audit event catalogue.
const (
	UserCreated          Kind = "user.created"
	UserUpdated          Kind = "user.updated"
	UserDeleted          Kind = "user.deleted"
	UserRestored         Kind = "user.restored"
	LoginSucceeded       Kind = "login.succeeded"
	LoginFailed          Kind = "login.failed"
	LoginRequested       Kind = "login.requested"
	SessionRevoked       Kind = "session.revoked"
	SessionReuseDetected Kind = "session.reuse_detected"
	EmailChanged         Kind = "email.changed"
	PasskeyAdded         Kind = "passkey.added"
	PasskeyRemoved       Kind = "passkey.removed"
	PasskeyRenamed       Kind = "passkey.renamed"
	TOTPEnabled          Kind = "totp.enabled"
	TOTPDisabled         Kind = "totp.disabled"
	RecoveryRequested    Kind = "recovery.requested"
	RecoveryConfirmed    Kind = "recovery.confirmed"
	RecoveryCancelled    Kind = "recovery.cancelled"
	OAuthLinked          Kind = "oauth.linked"
	OAuthUnlinked        Kind = "oauth.unlinked"
	OrgCreated           Kind = "org.created"
	OrgUpdated           Kind = "org.updated"
	OrgDeleted           Kind = "org.deleted"
	MemberAdded          Kind = "member.added"
	MemberRoleChanged    Kind = "member.role_changed"
	MemberRemoved        Kind = "member.removed"
	MemberJoined         Kind = "member.joined"
	InvitationSent       Kind = "invitation.sent"
	InvitationAccepted   Kind = "invitation.accepted"
	APIKeyCreated        Kind = "api_key.created"
	APIKeyRevoked        Kind = "api_key.revoked"
	SSOUpdated           Kind = "sso.updated"
	SSODeleted           Kind = "sso.deleted"
	CapturePolicyUpdated Kind = "capture_policy.updated"
)

var kinds = []Kind{
	UserCreated, UserUpdated, UserDeleted, UserRestored, LoginSucceeded, LoginFailed, LoginRequested, SessionRevoked, SessionReuseDetected,
	EmailChanged, PasskeyAdded, PasskeyRemoved, PasskeyRenamed, TOTPEnabled, TOTPDisabled,
	RecoveryRequested, RecoveryConfirmed, RecoveryCancelled, OAuthLinked, OAuthUnlinked,
	OrgCreated, OrgUpdated, OrgDeleted, MemberAdded, MemberRoleChanged, MemberRemoved, MemberJoined, InvitationSent, InvitationAccepted,
	APIKeyCreated, APIKeyRevoked, SSOUpdated, SSODeleted, CapturePolicyUpdated,
}

// Kinds returns every known event kind, in catalogue order.
func Kinds() []Kind { return slices.Clone(kinds) }

// Valid reports whether k is in the catalogue.
func (k Kind) Valid() bool { return slices.Contains(kinds, k) }

// Event is one audit record.
type Event struct {
	// User is whose account the event is about; nil when no account matched
	// (for example a failed login for an unknown email).
	User *uuid.UUID
	// Actor is who did it; nil for the system or an anonymous caller.
	Actor *uuid.UUID
	Kind  Kind
	// Meta is event-specific detail, stored as a JSON object. It must never
	// hold secrets (codes, tokens, passwords).
	Meta map[string]any
}

// maxUserAgent bounds the stored user agent; the header is client-controlled.
const maxUserAgent = 512

// Request is the client of the HTTP request an event is recorded under.
type Request struct {
	IP        netip.Addr // invalid when unknown
	UserAgent string
}

type requestKey struct{}

// WithRequest returns a context carrying the request client.
func WithRequest(ctx context.Context, r Request) context.Context {
	return context.WithValue(ctx, requestKey{}, r)
}

// RequestFrom returns the request client stored by WithRequest or
// Middleware, or the zero Request.
func RequestFrom(ctx context.Context) Request {
	r, _ := ctx.Value(requestKey{}).(Request)
	return r
}

// FromHTTP extracts the client of r: the peer address of the connection and
// the User-Agent header. Forwarding headers (X-Forwarded-For) are ignored:
// they are client-controlled unless a trusted proxy sets them.
func FromHTTP(r *http.Request) Request {
	var ip netip.Addr
	if ap, err := netip.ParseAddrPort(r.RemoteAddr); err == nil {
		ip = ap.Addr()
	} else if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		ip, _ = netip.ParseAddr(host)
	} else {
		ip, _ = netip.ParseAddr(r.RemoteAddr)
	}
	ua := r.UserAgent()
	if len(ua) > maxUserAgent {
		ua = ua[:maxUserAgent]
	}
	return Request{IP: ip.Unmap().WithZone(""), UserAgent: ua}
}

// Middleware stores the request client in the request context for Record.
func Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r.WithContext(WithRequest(r.Context(), FromHTTP(r))))
	})
}

type txKey struct{}

// WithTx returns a context whose audit events are written in tx.
func WithTx(ctx context.Context, tx pgx.Tx) context.Context {
	return context.WithValue(ctx, txKey{}, tx)
}

// Recorder writes audit events.
type Recorder struct {
	q *db.Queries
}

// New returns a Recorder that writes through conn (usually the pool) when the
// context carries no transaction.
func New(conn db.DBTX) *Recorder {
	return &Recorder{q: db.New(conn)}
}

// Record writes e, in the context's transaction when there is one, with the
// IP and user agent of the context's request.
func (r *Recorder) Record(ctx context.Context, e Event) error {
	p, err := params(ctx, e)
	if err != nil {
		return err
	}
	q := r.q
	if tx, ok := ctx.Value(txKey{}).(pgx.Tx); ok && tx != nil {
		q = q.WithTx(tx)
	}
	if _, err := q.InsertAuditEvent(ctx, p); err != nil {
		return fmt.Errorf("audit: record %s: %w", e.Kind, err)
	}
	return nil
}

// params builds the insert for e from e and the context's request.
func params(ctx context.Context, e Event) (db.InsertAuditEventParams, error) {
	if !e.Kind.Valid() {
		return db.InsertAuditEventParams{}, fmt.Errorf("audit: unknown event kind %q", e.Kind)
	}
	meta := []byte(`{}`)
	if len(e.Meta) > 0 {
		b, err := json.Marshal(e.Meta)
		if err != nil {
			return db.InsertAuditEventParams{}, fmt.Errorf("audit: encode %s metadata: %w", e.Kind, err)
		}
		meta = b
	}
	req := RequestFrom(ctx)
	p := db.InsertAuditEventParams{
		UserID:      e.User,
		ActorUserID: e.Actor,
		Event:       string(e.Kind),
		UserAgent:   req.UserAgent,
		Metadata:    meta,
	}
	if req.IP.IsValid() {
		ip := req.IP
		p.Ip = &ip
	}
	return p, nil
}
