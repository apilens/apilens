// Package access answers who has access to a project and why (ADR 0009,
// D3 in #753). A person's effective project role is the highest of three
// sources: their organization role (owners and admins are admin on every
// project), the project's default access for org members, and a direct
// grant. It is computed from Postgres, never stored; SpiceDB holds the same
// relationships through the outbox and answers the permission checks.
package access

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/apilens/apilens/internal/controlplane/orgs"
	"github.com/apilens/apilens/internal/controlplane/store/db"
)

// Project roles, lowest first.
const (
	RoleViewer = "viewer"
	RoleEditor = "editor"
	RoleAdmin  = "admin"
)

// Kinds of Source.
const (
	SourceOrgRole = "org_role" // the organization role (owner or admin)
	SourceDefault = "default"  // the project's default access for org members
	SourceDirect  = "direct"   // a direct project grant
)

// Limits of a page.
const (
	DefaultLimit = 50
	MaxLimit     = 200
)

var (
	// ErrNotFound is returned for a project that does not exist or is
	// deleted.
	ErrNotFound = errors.New("access: project not found")
	// ErrInvalid is returned for a malformed cursor or an unknown role or
	// source filter.
	ErrInvalid = errors.New("access: invalid filter")
)

// roles maps a rank of ListProjectAccess to its role.
var roles = [...]string{"", RoleViewer, RoleEditor, RoleAdmin}

func rank(role string) int32 {
	for i, r := range roles {
		if r != "" && r == role {
			return int32(i)
		}
	}
	return 0
}

// Source is one reason a person has a role on the project.
type Source struct {
	Kind string // SourceOrgRole, SourceDefault or SourceDirect
	Role string // the project role it grants
	// OrgRole is the organization role it comes from, for SourceOrgRole
	// and SourceDefault; "" for SourceDirect.
	OrgRole string
}

// Actor is the user who added a direct grant.
type Actor struct {
	ID   uuid.UUID
	Name string // their name, or their email when they have not set one
}

// Person is an org member who can view the project.
type Person struct {
	UserID        uuid.UUID
	Email         string
	Name          string
	Initials      string
	EffectiveRole string
	Sources       []Source // org_role, default, direct, in that order
	DirectRole    *string
	// AddedBy is who granted the direct role; nil without one, or once
	// their account is deleted.
	AddedBy *Actor
	// AddedAt is when the direct role was granted, or when the person
	// joined the organization without one.
	AddedAt      time.Time
	LastActiveAt *time.Time
}

// Filter narrows and pages the list.
type Filter struct {
	Q      string // substring of name or email, case-insensitive
	Role   string // effective role
	Source string // a source kind the person has
	Limit  int    // 0 means DefaultLimit
	Cursor string // NextCursor of the previous page
}

// Page is one page of the people with access, by email.
type Page struct {
	DefaultAccess string
	People        []Person
	NextCursor    string // "" on the last page
}

// Service reads and manages project access.
type Service struct {
	pool       *pgxpool.Pool
	audit      Auditor
	notifier   Notifier
	maxMembers int // 0: no cap on direct grants
}

// New returns a Service over pool.
func New(pool *pgxpool.Pool) *Service {
	return &Service{pool: pool, maxMembers: DefaultMaxDirectMembers}
}

var likeEscaper = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)

// List returns the org members who can view project with their effective
// role and its sources. The caller has checked that the user may view it.
func (s *Service) List(ctx context.Context, project uuid.UUID, f Filter) (Page, error) {
	arg := db.ListProjectAccessParams{ProjectID: project}
	limit := f.Limit
	if limit <= 0 {
		limit = DefaultLimit
	}
	if limit > MaxLimit {
		limit = MaxLimit
	}
	arg.RowLimit = int32(limit) + 1
	if q := strings.TrimSpace(f.Q); q != "" {
		q = likeEscaper.Replace(q)
		arg.Q = &q
	}
	if f.Role != "" {
		r := rank(f.Role)
		if r == 0 {
			return Page{}, ErrInvalid
		}
		arg.EffectiveRank = &r
	}
	switch f.Source {
	case "":
	case SourceOrgRole, SourceDefault, SourceDirect:
		src := f.Source
		arg.Source = &src
	default:
		return Page{}, ErrInvalid
	}
	if f.Cursor != "" {
		email, id, err := decodeCursor(f.Cursor)
		if err != nil {
			return Page{}, ErrInvalid
		}
		arg.AfterEmail, arg.AfterID = &email, &id
	}

	q := db.New(s.pool)
	def, err := q.GetProjectDefaultAccess(ctx, project)
	if errors.Is(err, pgx.ErrNoRows) {
		return Page{}, ErrNotFound
	}
	if err != nil {
		return Page{}, fmt.Errorf("access: default access: %w", err)
	}
	rows, err := q.ListProjectAccess(ctx, arg)
	if err != nil {
		return Page{}, fmt.Errorf("access: list: %w", err)
	}
	page := Page{DefaultAccess: def}
	if len(rows) > limit {
		rows = rows[:limit]
		last := rows[len(rows)-1]
		page.NextCursor = encodeCursor(last.Email, last.UserID)
	}
	page.People = make([]Person, 0, len(rows))
	for _, r := range rows {
		page.People = append(page.People, toPerson(r))
	}
	return page, nil
}

func toPerson(r db.ListProjectAccessRow) Person {
	p := Person{
		UserID: r.UserID, Email: r.Email, Name: r.Name, EffectiveRole: roles[r.EffectiveRank],
		DirectRole: r.DirectRole, AddedAt: r.JoinedAt, LastActiveAt: r.LastLoginAt,
	}
	display := r.Name
	if strings.TrimSpace(display) == "" {
		display = r.Email
	}
	p.Initials = orgs.Initials(display)
	if r.OrgRank > 0 {
		p.Sources = append(p.Sources, Source{Kind: SourceOrgRole, Role: roles[r.OrgRank], OrgRole: r.OrgRole})
	}
	if r.DefaultRank > 0 {
		p.Sources = append(p.Sources, Source{Kind: SourceDefault, Role: roles[r.DefaultRank], OrgRole: r.OrgRole})
	}
	if r.DirectRank > 0 {
		p.Sources = append(p.Sources, Source{Kind: SourceDirect, Role: roles[r.DirectRank]})
		if r.GrantedAt != nil {
			p.AddedAt = *r.GrantedAt
		}
		if r.AddedBy != nil && r.AddedByEmail != nil {
			name := *r.AddedByEmail
			if r.AddedByName != nil && strings.TrimSpace(*r.AddedByName) != "" {
				name = *r.AddedByName
			}
			p.AddedBy = &Actor{ID: *r.AddedBy, Name: name}
		}
	}
	return p
}

// A cursor is the user id and email of the last person of a page,
// base64url-encoded as "<uuid>:<email>".
func encodeCursor(email string, id uuid.UUID) string {
	return base64.RawURLEncoding.EncodeToString([]byte(id.String() + ":" + email))
}

func decodeCursor(s string) (string, uuid.UUID, error) {
	b, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return "", uuid.Nil, err
	}
	const idLen = 36
	if len(b) < idLen+2 || b[idLen] != ':' {
		return "", uuid.Nil, errors.New("malformed cursor")
	}
	id, err := uuid.Parse(string(b[:idLen]))
	if err != nil {
		return "", uuid.Nil, err
	}
	return string(b[idLen+1:]), id, nil
}
