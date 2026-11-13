// Package auditlog serves the audit trail of an organization and of a
// project (D7). The events live in identity's audit_events table (ADR 0005)
// and are read through identity's audit.Reader; this package only decides
// which projects' events the caller may see and names those projects.
package auditlog

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/identity/audit"
)

// Checker answers permission checks in bulk; *authz.Client satisfies it.
type Checker interface {
	CheckBulk(ctx context.Context, items []authz.CheckItem) ([]bool, error)
}

// Events reads audit events; *audit.Reader satisfies it.
type Events interface {
	ListProject(ctx context.Context, project uuid.UUID, q audit.Query) (audit.Page, error)
	ListOrg(ctx context.Context, org uuid.UUID, visible []uuid.UUID, q audit.Query) (audit.Page, error)
}

// Projects lists an organization's active projects; *db.Queries satisfies it.
type Projects interface {
	ListOrgProjects(ctx context.Context, orgID uuid.UUID) ([]db.ListOrgProjectsRow, error)
}

// Project names the project an org-level event belongs to.
type Project struct {
	Slug string
	Name string
}

// Entry is a listed event; Project is set on the org listing for a project
// event.
type Entry struct {
	audit.Entry
	ProjectRef *Project
}

// Page is one page of a listing.
type Page struct {
	Entries    []Entry
	NextCursor string
}

// Service lists audit events.
type Service struct {
	events   Events
	projects Projects
	checker  Checker
}

// New returns a Service over pool, checking project visibility with checker.
func New(pool *pgxpool.Pool, checker Checker) *Service {
	return NewWith(audit.NewReader(pool), db.New(pool), checker)
}

// NewWith returns a Service over its parts (tests).
func NewWith(events Events, projects Projects, checker Checker) *Service {
	return &Service{events: events, projects: projects, checker: checker}
}

// ListProject lists project's events. The caller has been authorized for
// view_audit on it.
func (s *Service) ListProject(ctx context.Context, project uuid.UUID, q audit.Query) (Page, error) {
	p, err := s.events.ListProject(ctx, project, q)
	if err != nil {
		return Page{}, err
	}
	out := Page{NextCursor: p.NextCursor, Entries: make([]Entry, 0, len(p.Entries))}
	for _, e := range p.Entries {
		out.Entries = append(out.Entries, Entry{Entry: e})
	}
	return out, nil
}

// ListOrg lists org's events for user: its org-wide events and those of the
// active projects user can view, never those of another project. The
// caller has been authorized for manage on the organization. It fails
// (wrapping authz.ErrUnavailable) when SpiceDB cannot answer.
func (s *Service) ListOrg(ctx context.Context, user, org uuid.UUID, q audit.Query) (Page, error) {
	rows, err := s.projects.ListOrgProjects(ctx, org)
	if err != nil {
		return Page{}, fmt.Errorf("auditlog: list projects: %w", err)
	}
	names := make(map[uuid.UUID]*Project, len(rows))
	visible := []uuid.UUID{}
	if len(rows) > 0 {
		items := make([]authz.CheckItem, len(rows))
		for i, r := range rows {
			items[i] = authz.CheckItem{Subject: authz.User(user.String()), Permission: authz.ProjectView, Resource: authz.Project(org.String(), r.ID.String())}
		}
		allowed, err := s.checker.CheckBulk(ctx, items)
		if err != nil {
			return Page{}, fmt.Errorf("auditlog: project visibility: %w", err)
		}
		for i, r := range rows {
			if i < len(allowed) && allowed[i] {
				visible = append(visible, r.ID)
				names[r.ID] = &Project{Slug: r.Slug, Name: r.Name}
			}
		}
	}
	p, err := s.events.ListOrg(ctx, org, visible, q)
	if err != nil {
		return Page{}, err
	}
	out := Page{NextCursor: p.NextCursor, Entries: make([]Entry, 0, len(p.Entries))}
	for _, e := range p.Entries {
		en := Entry{Entry: e}
		if e.Project != nil {
			ref, ok := names[*e.Project]
			if !ok {
				// The store keeps project events to visible; never show
				// another project's, whatever it returns.
				continue
			}
			en.ProjectRef = ref
		}
		out.Entries = append(out.Entries, en)
	}
	return out, nil
}
