// Package auditlog serves the audit trail of an organization and of a
// project (D7). The events live in identity's audit_events table (ADR 0005)
// and are read through identity's audit.Reader; this package only decides
// which projects' events the caller may see and names those projects.
package auditlog

import (
	"context"
	"errors"
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

// Exports prepares audit event exports; *audit.Reader satisfies it.
type Exports interface {
	ExportProject(ctx context.Context, project uuid.UUID, q audit.Query) (*audit.Export, error)
	ExportOrg(ctx context.Context, org uuid.UUID, visible []uuid.UUID, q audit.Query) (*audit.Export, error)
}

// Recorder records audit events; *audit.Recorder satisfies it.
type Recorder interface {
	Record(ctx context.Context, e audit.Event) error
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
	exports  Exports
	recorder Recorder
}

// New returns a Service over pool, checking project visibility with checker.
func New(pool *pgxpool.Pool, checker Checker) *Service {
	r := audit.NewReader(pool)
	return NewWith(r, db.New(pool), checker).WithExports(r, audit.New(pool))
}

// NewWith returns a Service over its parts (tests).
func NewWith(events Events, projects Projects, checker Checker) *Service {
	return &Service{events: events, projects: projects, checker: checker}
}

// WithExports lets s export events from exports, recording each export
// with recorder.
func (s *Service) WithExports(exports Exports, recorder Recorder) *Service {
	s.exports, s.recorder = exports, recorder
	return s
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
	visible, names, err := s.visibleProjects(ctx, user, org)
	if err != nil {
		return Page{}, err
	}
	p, err := s.events.ListOrg(ctx, org, visible, q)
	if err != nil {
		return Page{}, err
	}
	out := Page{NextCursor: p.NextCursor, Entries: make([]Entry, 0, len(p.Entries))}
	for _, e := range p.Entries {
		if en, ok := orgEntry(e, names); ok {
			out.Entries = append(out.Entries, en)
		}
	}
	return out, nil
}

// visibleProjects returns the active projects of org that user can view,
// and their names.
func (s *Service) visibleProjects(ctx context.Context, user, org uuid.UUID) ([]uuid.UUID, map[uuid.UUID]*Project, error) {
	rows, err := s.projects.ListOrgProjects(ctx, org)
	if err != nil {
		return nil, nil, fmt.Errorf("auditlog: list projects: %w", err)
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
			return nil, nil, fmt.Errorf("auditlog: project visibility: %w", err)
		}
		for i, r := range rows {
			if i < len(allowed) && allowed[i] {
				visible = append(visible, r.ID)
				names[r.ID] = &Project{Slug: r.Slug, Name: r.Name}
			}
		}
	}
	return visible, names, nil
}

// orgEntry names the project of an org-list event; false for an event of a
// project not in names. The store keeps project events to the visible
// projects: never show another project's, whatever it returns.
func orgEntry(e audit.Entry, names map[uuid.UUID]*Project) (Entry, bool) {
	en := Entry{Entry: e}
	if e.Project != nil {
		ref, ok := names[*e.Project]
		if !ok {
			return Entry{}, false
		}
		en.ProjectRef = ref
	}
	return en, true
}

// ErrExportsUnavailable is returned by the exports of a Service made
// without WithExports.
var ErrExportsUnavailable = errors.New("auditlog: exports are not configured")

// Export is an audit export ready to stream: Rows events (at most
// audit.MaxExportRows), newest first; Truncated when more matched.
type Export struct {
	Rows      int
	Truncated bool
	each      func(ctx context.Context, fn func(Entry) error) error
}

// NewExport returns an export of rows events that each yields (tests and
// other sources).
func NewExport(rows int, truncated bool, each func(ctx context.Context, fn func(Entry) error) error) Export {
	return Export{Rows: rows, Truncated: truncated, each: each}
}

// Each calls fn with every event of the export, newest first, stopping at
// the first error.
func (e Export) Each(ctx context.Context, fn func(Entry) error) error {
	if e.each == nil {
		return nil
	}
	return e.each(ctx, fn)
}

// ExportRequest says who exports which events, for the audit_log.exported
// event recorded before the export is returned.
type ExportRequest struct {
	Actor uuid.UUID
	Org   uuid.UUID
	// Format is the export format ("csv"); Filters the non-empty filters,
	// both recorded in the event's metadata.
	Format  string
	Filters map[string]string
	Query   audit.Query
}

// ExportProject prepares the export of project's events (every Entry's
// ProjectRef is ref) and records audit_log.exported. The caller has been
// authorized for view_audit on it.
func (s *Service) ExportProject(ctx context.Context, project uuid.UUID, ref Project, r ExportRequest) (Export, error) {
	if s.exports == nil || s.recorder == nil {
		return Export{}, ErrExportsUnavailable
	}
	x, err := s.exports.ExportProject(ctx, project, r.Query)
	if err != nil {
		return Export{}, err
	}
	if err := s.recordExport(ctx, &project, r, x); err != nil {
		return Export{}, err
	}
	return NewExport(x.Rows, x.Truncated, func(ctx context.Context, fn func(Entry) error) error {
		return x.Each(ctx, func(e audit.Entry) error { return fn(Entry{Entry: e, ProjectRef: &ref}) })
	}), nil
}

// ExportOrg prepares the export of org's events for r.Actor, keeping to the
// projects they can view like ListOrg, and records audit_log.exported. The
// caller has been authorized for manage on the organization.
func (s *Service) ExportOrg(ctx context.Context, r ExportRequest) (Export, error) {
	if s.exports == nil || s.recorder == nil {
		return Export{}, ErrExportsUnavailable
	}
	visible, names, err := s.visibleProjects(ctx, r.Actor, r.Org)
	if err != nil {
		return Export{}, err
	}
	x, err := s.exports.ExportOrg(ctx, r.Org, visible, r.Query)
	if err != nil {
		return Export{}, err
	}
	if err := s.recordExport(ctx, nil, r, x); err != nil {
		return Export{}, err
	}
	return NewExport(x.Rows, x.Truncated, func(ctx context.Context, fn func(Entry) error) error {
		return x.Each(ctx, func(e audit.Entry) error {
			en, ok := orgEntry(e, names)
			if !ok {
				return nil
			}
			return fn(en)
		})
	}), nil
}

// recordExport records audit_log.exported for x. An export that cannot be
// audited is refused.
func (s *Service) recordExport(ctx context.Context, project *uuid.UUID, r ExportRequest, x *audit.Export) error {
	filters := map[string]any{}
	for k, v := range r.Filters {
		if v != "" {
			filters[k] = v
		}
	}
	actor, org := r.Actor, r.Org
	err := s.recorder.Record(ctx, audit.Event{
		Actor: &actor, Kind: audit.AuditLogExported, Org: &org, Project: project,
		Meta: map[string]any{"format": r.Format, "filters": filters, "rows": x.Rows, "truncated": x.Truncated},
	})
	if err != nil {
		return fmt.Errorf("auditlog: record export: %w", err)
	}
	return nil
}
