package audit

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/identity/store/db"
)

// Listing pages: DefaultPageSize when the caller names none, at most
// MaxPageSize.
const (
	DefaultPageSize = 50
	MaxPageSize     = 200
)

// ErrInvalidCursor is returned by Reader.List for a cursor it did not issue.
var ErrInvalidCursor = errors.New("audit: invalid cursor")

// Query selects the events of an organization (Reader.ListOrg) or a project
// (Reader.ListProject). Zero fields do not filter.
type Query struct {
	// Actor keeps the events this user did.
	Actor *uuid.UUID
	// Action keeps one kind ("api_key.created"), or every kind with a prefix
	// when it ends with a dot ("api_key.").
	Action string
	// TargetType keeps the events on this type of target ("api_key").
	TargetType string
	// From and To keep the events in [From, To).
	From, To *time.Time
	// Q keeps the events whose target label contains it (case-insensitive).
	Q string
	// Limit is the page size: DefaultPageSize when <= 0, at most
	// MaxPageSize.
	Limit int
	// Cursor is the NextCursor of the previous page; "" for the first.
	Cursor string
}

// Entry is one listed audit event.
type Entry struct {
	ID   int64
	Time time.Time
	Kind string
	// Actor is who did it; nil for the system. ActorLabel is their name (or
	// email) when the event was recorded, "" when unknown.
	Actor      *uuid.UUID
	ActorLabel string
	// Project is the project the event belongs to; nil for an org-wide
	// event.
	Project   *uuid.UUID
	Target    Target
	IP        string
	UserAgent string
	RequestID string
	// Changes is the stored {"previous": ..., "next": ...} JSON; nil when
	// the event is not a change.
	Changes []byte
}

// Page is one page of a listing, newest first.
type Page struct {
	Entries []Entry
	// NextCursor fetches the next page; "" on the last page.
	NextCursor string
}

// Reader lists audit events. The audit table belongs to identity (ADR 0005):
// other roles read it only through this type.
type Reader struct {
	q *db.Queries
}

// NewReader returns a Reader over conn (usually the pool).
func NewReader(conn db.DBTX) *Reader { return &Reader{q: db.New(conn)} }

// filter is the decoded part of a Query shared by both listings.
type filter struct {
	limit                        int
	event, prefix, target, label *string
	beforeAt                     *time.Time
	beforeID                     *int64
}

func (q Query) filter() (filter, error) {
	f := filter{limit: q.Limit, target: nonEmpty(q.TargetType), label: nonEmpty(q.Q)}
	if f.limit <= 0 {
		f.limit = DefaultPageSize
	}
	f.limit = min(f.limit, MaxPageSize)
	if q.Action != "" {
		if strings.HasSuffix(q.Action, ".") {
			f.prefix = &q.Action
		} else {
			f.event = &q.Action
		}
	}
	if q.Cursor != "" {
		at, id, err := decodeCursor(q.Cursor)
		if err != nil {
			return filter{}, err
		}
		f.beforeAt, f.beforeID = &at, &id
	}
	return f, nil
}

// ListProject lists the events of project, newest first.
func (r *Reader) ListProject(ctx context.Context, project uuid.UUID, q Query) (Page, error) {
	f, err := q.filter()
	if err != nil {
		return Page{}, err
	}
	rows, err := r.q.ListAuditEventsForProject(ctx, db.ListAuditEventsForProjectParams{
		ProjectID: project, ActorUserID: q.Actor, Event: f.event, EventPrefix: f.prefix, TargetType: f.target, TargetLabel: f.label,
		FromTime: q.From, ToTime: q.To, BeforeCreatedAt: f.beforeAt, BeforeID: f.beforeID, PageSize: int32(f.limit + 1),
	})
	if err != nil {
		return Page{}, fmt.Errorf("audit: list project events: %w", err)
	}
	return page(rows, f.limit), nil
}

// ListOrg lists the events of org, newest first: its org-wide events and
// those of the projects in visible only. A nil visible keeps no project
// event.
func (r *Reader) ListOrg(ctx context.Context, org uuid.UUID, visible []uuid.UUID, q Query) (Page, error) {
	f, err := q.filter()
	if err != nil {
		return Page{}, err
	}
	if visible == nil {
		visible = []uuid.UUID{}
	}
	rows, err := r.q.ListAuditEventsForOrg(ctx, db.ListAuditEventsForOrgParams{
		OrgID: org, VisibleProjects: visible, ActorUserID: q.Actor, Event: f.event, EventPrefix: f.prefix, TargetType: f.target, TargetLabel: f.label,
		FromTime: q.From, ToTime: q.To, BeforeCreatedAt: f.beforeAt, BeforeID: f.beforeID, PageSize: int32(f.limit + 1),
	})
	if err != nil {
		return Page{}, fmt.Errorf("audit: list org events: %w", err)
	}
	return page(rows, f.limit), nil
}

// page turns up to limit+1 rows into a page; the extra row only says there
// is a next page.
func page(rows []db.AuditEvent, limit int) Page {
	var p Page
	if len(rows) > limit {
		rows = rows[:limit]
		last := rows[limit-1]
		p.NextCursor = encodeCursor(last.CreatedAt, last.ID)
	}
	p.Entries = make([]Entry, 0, len(rows))
	for _, e := range rows {
		en := Entry{
			ID: e.ID, Time: e.CreatedAt, Kind: e.Event, Actor: e.ActorUserID, ActorLabel: deref(e.ActorLabel), Project: e.ProjectID,
			Target:    Target{Type: deref(e.TargetType), ID: deref(e.TargetID), Label: deref(e.TargetLabel)},
			UserAgent: e.UserAgent, RequestID: deref(e.RequestID), Changes: e.Changes,
		}
		if e.Ip != nil {
			en.IP = e.Ip.String()
		}
		p.Entries = append(p.Entries, en)
	}
	return p
}

// A cursor is base64url("<created_at RFC 3339 nano>|<id>"): the position of
// the last row of the page, so rows with equal timestamps never repeat or go
// missing across pages.
func encodeCursor(at time.Time, id int64) string {
	return base64.RawURLEncoding.EncodeToString([]byte(at.UTC().Format(time.RFC3339Nano) + "|" + strconv.FormatInt(id, 10)))
}

func decodeCursor(s string) (time.Time, int64, error) {
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return time.Time{}, 0, ErrInvalidCursor
	}
	ts, ids, ok := strings.Cut(string(b), "|")
	if !ok {
		return time.Time{}, 0, ErrInvalidCursor
	}
	at, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil {
		return time.Time{}, 0, ErrInvalidCursor
	}
	id, err := strconv.ParseInt(ids, 10, 64)
	if err != nil {
		return time.Time{}, 0, ErrInvalidCursor
	}
	return at, id, nil
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// Action is a catalogue entry offered as a filter: its kind and a label to
// show.
type Action struct {
	Kind  Kind
	Label string
}

// accountOnly are the kinds about a person's own account; they are never
// scoped to an organization, so org and project listings never show them.
var accountOnly = map[Kind]bool{
	UserCreated: true, UserUpdated: true, UserDeleted: true, UserRestored: true,
	LoginSucceeded: true, LoginFailed: true, LoginRequested: true,
	SessionRevoked: true, SessionReuseDetected: true, SessionReauthenticated: true, SessionReauthFailed: true,
	EmailChanged: true, PasskeyAdded: true, PasskeyRemoved: true, PasskeyRenamed: true,
	TOTPEnabled: true, TOTPDisabled: true, RecoveryRequested: true, RecoveryConfirmed: true, RecoveryCancelled: true,
	OAuthLinked: true, OAuthUnlinked: true,
}

// labels are the display names of the org-scoped kinds. A kind without one
// gets a label made from its name (see Label).
var labels = map[Kind]string{
	OrgCreated:           "Organization created",
	OrgUpdated:           "Organization updated",
	OrgDeleted:           "Organization deleted",
	MemberAdded:          "Member added",
	MemberRoleChanged:    "Member role changed",
	MemberRemoved:        "Member removed",
	MemberJoined:         "Member joined",
	InvitationSent:       "Invitation sent",
	InvitationAccepted:   "Invitation accepted",
	APIKeyCreated:        "API key created",
	APIKeyRevoked:        "API key revoked",
	APIKeyUpdated:        "API key updated",
	SSOUpdated:           "SSO connection updated",
	SSODeleted:           "SSO connection deleted",
	CapturePolicyUpdated: "Capture policy updated",
	AppCreated:           "App created",
	AppArchived:          "App archived",
	AppRestored:          "App restored",
	AppRenamed:           "App renamed",
	AppMerged:            "App merged",
	AppDeleted:           "App deleted",
	AppAcknowledged:      "App acknowledged",
}

// Label is the display name of k: "API key created" for api_key.created.
func (k Kind) Label() string {
	if l, ok := labels[k]; ok {
		return l
	}
	s := strings.NewReplacer(".", " ", "_", " ").Replace(string(k))
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// Actions returns the kinds org and project listings can hold (the
// catalogue without personal account events), with their labels, in
// catalogue order.
func Actions() []Action {
	out := make([]Action, 0, len(kinds))
	for _, k := range kinds {
		if !accountOnly[k] {
			out = append(out, Action{Kind: k, Label: k.Label()})
		}
	}
	return out
}
