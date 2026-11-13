// Package audit records security-relevant account events in audit_events,
// for users (and later admins) to inspect.
//
// Callers record an event with Recorder.Record. The client IP, user agent and
// request id are not passed in: Middleware captures them from the HTTP
// request into the context, so every event recorded while serving a request
// carries them. The actor's name at the time (actor_label) is looked up by
// the insert itself.
//
// An event about an organization or project names it (Event.Org,
// Event.Project), what was acted on (Event.Target) and, for a change, the
// values before and after (Event.Changes). Changes never hold secrets: Record
// refuses them, and Redact masks them in a map before it is recorded. When
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
	APIKeyUpdated        Kind = "api_key.updated"
	AppCreated           Kind = "app.created"
	AppArchived          Kind = "app.archived"
	AppRestored          Kind = "app.restored"
	AppRenamed           Kind = "app.renamed"
	AppMerged            Kind = "app.merged"
	AppDeleted           Kind = "app.deleted"
	AppAcknowledged      Kind = "app.acknowledged"
	// SessionReauthenticated: the user confirmed who they are again
	// without signing out (POST /api/v1/auth/reauth/verify).
	SessionReauthenticated Kind = "session.reauthenticated"
	// SessionReauthFailed: a re-authentication attempt failed.
	SessionReauthFailed Kind = "session.reauth_failed"
	// APIKeyRotated: a project API key was replaced by a successor; the
	// old one keeps working until the end of the overlap window.
	APIKeyRotated           Kind = "api_key.rotated"
	ProjectCreated          Kind = "project.created"
	ProjectUpdated          Kind = "project.updated"
	EnvironmentAdded        Kind = "environment.added"
	EnvironmentUpdated      Kind = "environment.updated"
	EnvironmentRemoved      Kind = "environment.removed"
	PrivacyPolicyUpdated    Kind = "privacy_policy.updated"
	InvitationRevoked       Kind = "invitation.revoked"
	AlertRuleCreated        Kind = "alert_rule.created"
	AlertRuleUpdated        Kind = "alert_rule.updated"
	AlertRuleDeleted        Kind = "alert_rule.deleted"
	AlertChannelCreated     Kind = "alert_channel.created"
	AlertChannelUpdated     Kind = "alert_channel.updated"
	AlertChannelDeleted     Kind = "alert_channel.deleted"
	HealthCheckCreated      Kind = "health_check.created"
	HealthCheckDeleted      Kind = "health_check.deleted"
	AppSettingsUpdated      Kind = "app_settings.updated"
	EndpointSettingsUpdated Kind = "endpoint_settings.updated"
	// ProjectMemberAdded, ProjectMemberRoleChanged, ProjectMemberRemoved: a
	// direct project role is granted, changed or removed.
	ProjectMemberAdded       Kind = "project_member.added"
	ProjectMemberRoleChanged Kind = "project_member.role_changed"
	ProjectMemberRemoved     Kind = "project_member.removed"
	// ProjectAccessChanged: a project's default access for org members
	// changes.
	ProjectAccessChanged Kind = "project.access_changed"
	// AuditLogExported: an organization's or project's audit events were
	// exported (GET .../audit-events/export).
	AuditLogExported Kind = "audit_log.exported"
	// APIKeyExpired: a project API key passed its expires_at; written once,
	// with no actor, by the hourly API key expiry job.
	APIKeyExpired Kind = "api_key.expired"
	// ProjectPaused, ProjectResumed: ingest for a project is paused (the
	// edge answers 403 project_paused) or resumed.
	ProjectPaused  Kind = "project.paused"
	ProjectResumed Kind = "project.resumed"
	// ProjectDeleted: a project is deleted and scheduled for purge
	// (changes: purge_after). ProjectRestored: it is restored before the
	// purge.
	ProjectDeleted  Kind = "project.deleted"
	ProjectRestored Kind = "project.restored"
	// ProjectSlugChanged: a project's slug is renamed; the old slug keeps
	// leading to the project and is reserved for it for 30 days.
	ProjectSlugChanged Kind = "project.slug_changed"
	// ProjectPurged: the purge job removed a deleted project's data after
	// its grace period (org-scoped: the project is gone; its own events keep
	// project_id and the target label).
	ProjectPurged Kind = "project.purged"
)

var kinds = []Kind{
	UserCreated, UserUpdated, UserDeleted, UserRestored, LoginSucceeded, LoginFailed, LoginRequested, SessionRevoked, SessionReuseDetected,
	EmailChanged, PasskeyAdded, PasskeyRemoved, PasskeyRenamed, TOTPEnabled, TOTPDisabled,
	RecoveryRequested, RecoveryConfirmed, RecoveryCancelled, OAuthLinked, OAuthUnlinked,
	OrgCreated, OrgUpdated, OrgDeleted, MemberAdded, MemberRoleChanged, MemberRemoved, MemberJoined, InvitationSent, InvitationAccepted,
	APIKeyCreated, APIKeyRevoked, SSOUpdated, SSODeleted, CapturePolicyUpdated,
	APIKeyUpdated, AppCreated, AppArchived, AppRestored, AppRenamed, AppMerged, AppDeleted, AppAcknowledged,
	SessionReauthenticated, SessionReauthFailed,
	APIKeyRotated,
	ProjectCreated, ProjectUpdated, EnvironmentAdded, EnvironmentUpdated, EnvironmentRemoved, PrivacyPolicyUpdated,
	InvitationRevoked, AlertRuleCreated, AlertRuleUpdated, AlertRuleDeleted, AlertChannelCreated, AlertChannelUpdated,
	AlertChannelDeleted, HealthCheckCreated, HealthCheckDeleted, AppSettingsUpdated, EndpointSettingsUpdated,
	ProjectMemberAdded, ProjectMemberRoleChanged, ProjectMemberRemoved, ProjectAccessChanged,
	AuditLogExported, APIKeyExpired,
	ProjectPaused, ProjectResumed,
	ProjectDeleted, ProjectRestored,
	ProjectSlugChanged,
	ProjectPurged,
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
	// Org and Project scope the event; nil for a personal account event
	// (Org) or an org-wide one (Project).
	Org     *uuid.UUID
	Project *uuid.UUID
	// Target is what was acted on; the zero Target when nothing in
	// particular (a sign-in).
	Target Target
	// Changes holds the values before and after a change; nil when the event
	// is not a change. It must never hold secrets: Record refuses a change
	// whose secret fields (see Redact) carry a value.
	Changes *Changes
	// Meta is event-specific detail, stored as a JSON object. It must never
	// hold secrets (codes, tokens, passwords).
	Meta map[string]any
}

// Target is what an event acted on: a type ("api_key", "member", "app"),
// its id, and a label that stays readable after the target is gone.
type Target struct {
	Type  string
	ID    string
	Label string
}

// Changes is the before and after of a change, stored as
// {"previous": ..., "next": ...}. Either side may be nil (a creation has no
// previous, a deletion no next). Values are JSON-encoded.
type Changes struct {
	Previous any `json:"previous"`
	Next     any `json:"next"`
}

// Diff returns the Changes from previous to next keeping only the fields
// whose values differ (compared by their JSON encoding), or nil when none
// does. A nil previous is a creation (every next field is kept) and a nil
// next a deletion (every previous field is kept). Secret fields are redacted
// (see Redact).
func Diff(previous, next map[string]any) *Changes {
	if previous == nil && next == nil {
		return nil
	}
	if previous == nil || next == nil {
		c := &Changes{}
		if previous != nil {
			c.Previous = Redact(previous)
		}
		if next != nil {
			c.Next = Redact(next)
		}
		return c
	}
	prev, nxt := map[string]any{}, map[string]any{}
	for k, v := range previous {
		if w, ok := next[k]; !ok || !sameJSON(v, w) {
			prev[k] = v
		}
	}
	for k, v := range next {
		if w, ok := previous[k]; !ok || !sameJSON(v, w) {
			nxt[k] = v
		}
	}
	if len(prev) == 0 && len(nxt) == 0 {
		return nil
	}
	return &Changes{Previous: Redact(prev), Next: Redact(nxt)}
}

func sameJSON(a, b any) bool {
	x, errA := json.Marshal(a)
	y, errB := json.Marshal(b)
	return errA == nil && errB == nil && string(x) == string(y)
}

// maxUserAgent bounds the stored user agent; the header is client-controlled.
const maxUserAgent = 512

// Request is the client of the HTTP request an event is recorded under.
type Request struct {
	IP        netip.Addr // invalid when unknown
	UserAgent string
	// ID identifies the request (Middleware assigns one and returns it in
	// the X-Request-Id response header); empty outside a request.
	ID string
}

// RequestIDHeader is the response header carrying the request id that the
// request's audit events record.
const RequestIDHeader = "X-Request-Id"

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

// Middleware stores the request client in the request context for Record,
// with a fresh request id that it also sets as the X-Request-Id response
// header. An incoming X-Request-Id is ignored: it is client-controlled.
func Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		req := FromHTTP(r)
		req.ID = newRequestID()
		w.Header().Set(RequestIDHeader, req.ID)
		next.ServeHTTP(w, r.WithContext(WithRequest(r.Context(), req)))
	})
}

// newRequestID returns a time-ordered UUID (v7), or a random one (v4) if the
// clock source fails.
func newRequestID() string {
	if id, err := uuid.NewV7(); err == nil {
		return id.String()
	}
	return uuid.NewString()
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
	var changes []byte
	if e.Changes != nil {
		b, err := json.Marshal(e.Changes)
		if err != nil {
			return db.InsertAuditEventParams{}, fmt.Errorf("audit: encode %s changes: %w", e.Kind, err)
		}
		if err := checkNoSecrets(b); err != nil {
			return db.InsertAuditEventParams{}, fmt.Errorf("audit: %s changes: %w", e.Kind, err)
		}
		changes = b
	}
	req := RequestFrom(ctx)
	p := db.InsertAuditEventParams{
		UserID:      e.User,
		ActorUserID: e.Actor,
		Event:       string(e.Kind),
		UserAgent:   req.UserAgent,
		Metadata:    meta,
		OrgID:       e.Org,
		ProjectID:   e.Project,
		TargetType:  nonEmpty(e.Target.Type),
		TargetID:    nonEmpty(e.Target.ID),
		TargetLabel: nonEmpty(e.Target.Label),
		RequestID:   nonEmpty(req.ID),
		Changes:     changes,
	}
	if req.IP.IsValid() {
		ip := req.IP
		p.Ip = &ip
	}
	return p, nil
}

// nonEmpty is s, or nil (SQL NULL) when s is empty.
func nonEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
