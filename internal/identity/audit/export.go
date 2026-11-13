package audit

import (
	"context"
	"fmt"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/identity/store/db"
)

// MaxExportRows caps an export: the newest MaxExportRows events that match,
// with Export.Truncated set when more match.
const MaxExportRows = 100_000

// exportPageSize is how many rows an export reads per query; memory stays
// bounded by it, whatever the export's size.
const exportPageSize = 1000

// Export is the events of a listing's filters (without its page), read
// page by page so its size never bounds memory. Make one with
// Reader.ExportProject or Reader.ExportOrg and read it with Each.
type Export struct {
	r *Reader
	// project is set for a project export; org and visible otherwise.
	project *uuid.UUID
	org     uuid.UUID
	visible []uuid.UUID
	q       Query
	f       filter
	// Rows is how many events Each yields, at most MaxExportRows.
	Rows int
	// Truncated is true when more than MaxExportRows events match: Each
	// yields only the newest MaxExportRows.
	Truncated bool
}

// ExportProject prepares an export of project's events matching q (its
// Limit and Cursor are ignored). Events recorded from now on are left out,
// so Rows and Truncated describe what Each yields.
func (r *Reader) ExportProject(ctx context.Context, project uuid.UUID, q Query) (*Export, error) {
	e, err := r.newExport(ctx, q)
	if err != nil {
		return nil, err
	}
	e.project = &project
	n, err := r.q.CountAuditEventsForProject(ctx, db.CountAuditEventsForProjectParams{
		ProjectID: project, ActorUserID: e.q.Actor, Event: e.f.event, EventPrefix: e.f.prefix, TargetType: e.f.target, TargetLabel: e.f.label,
		FromTime: e.q.From, ToTime: e.q.To, MaxRows: MaxExportRows + 1,
	})
	if err != nil {
		return nil, fmt.Errorf("audit: count project events: %w", err)
	}
	e.size(n)
	return e, nil
}

// ExportOrg prepares an export of org's events matching q, like ListOrg: its
// org-wide events and those of the projects in visible only.
func (r *Reader) ExportOrg(ctx context.Context, org uuid.UUID, visible []uuid.UUID, q Query) (*Export, error) {
	e, err := r.newExport(ctx, q)
	if err != nil {
		return nil, err
	}
	if visible == nil {
		visible = []uuid.UUID{}
	}
	e.org, e.visible = org, visible
	n, err := r.q.CountAuditEventsForOrg(ctx, db.CountAuditEventsForOrgParams{
		OrgID: org, VisibleProjects: visible, ActorUserID: e.q.Actor, Event: e.f.event, EventPrefix: e.f.prefix, TargetType: e.f.target, TargetLabel: e.f.label,
		FromTime: e.q.From, ToTime: e.q.To, MaxRows: MaxExportRows + 1,
	})
	if err != nil {
		return nil, fmt.Errorf("audit: count org events: %w", err)
	}
	e.size(n)
	return e, nil
}

func (r *Reader) newExport(ctx context.Context, q Query) (*Export, error) {
	q.Limit, q.Cursor = 0, ""
	// Freeze the end of the export, on the database clock, so events
	// recorded while it streams (its own audit_log.exported among them) do
	// not shift it.
	now, err := r.q.AuditClock(ctx)
	if err != nil {
		return nil, fmt.Errorf("audit: export clock: %w", err)
	}
	if q.To == nil || q.To.After(now) {
		q.To = &now
	}
	f, err := q.filter()
	if err != nil {
		return nil, err
	}
	f.limit = exportPageSize
	return &Export{r: r, q: q, f: f}, nil
}

func (e *Export) size(n int64) {
	e.Truncated = n > MaxExportRows
	e.Rows = int(min(n, MaxExportRows))
}

// Each calls fn with every event of the export, newest first, at most
// MaxExportRows, with ActorEmail set to the actor's current email. It stops
// at the first error fn or the store returns.
func (e *Export) Each(ctx context.Context, fn func(Entry) error) error {
	f := e.f
	sent := 0
	for sent < MaxExportRows {
		f.limit = min(exportPageSize, MaxExportRows-sent)
		rows, err := e.page(ctx, f)
		if err != nil {
			return err
		}
		emails, err := e.emails(ctx, rows)
		if err != nil {
			return err
		}
		p := page(rows, f.limit)
		for _, en := range p.Entries {
			if en.Actor != nil {
				en.ActorEmail = emails[*en.Actor]
			}
			if err := fn(en); err != nil {
				return err
			}
		}
		sent += len(p.Entries)
		if len(rows) <= f.limit {
			return nil
		}
		last := p.Entries[len(p.Entries)-1]
		f.beforeAt, f.beforeID = &last.Time, &last.ID
	}
	return nil
}

// page reads up to f.limit+1 rows after f's position.
func (e *Export) page(ctx context.Context, f filter) ([]db.AuditEvent, error) {
	if e.project != nil {
		rows, err := e.r.q.ListAuditEventsForProject(ctx, db.ListAuditEventsForProjectParams{
			ProjectID: *e.project, ActorUserID: e.q.Actor, Event: f.event, EventPrefix: f.prefix, TargetType: f.target, TargetLabel: f.label,
			FromTime: e.q.From, ToTime: e.q.To, BeforeCreatedAt: f.beforeAt, BeforeID: f.beforeID, PageSize: int32(f.limit + 1),
		})
		if err != nil {
			return nil, fmt.Errorf("audit: export project events: %w", err)
		}
		return rows, nil
	}
	rows, err := e.r.q.ListAuditEventsForOrg(ctx, db.ListAuditEventsForOrgParams{
		OrgID: e.org, VisibleProjects: e.visible, ActorUserID: e.q.Actor, Event: f.event, EventPrefix: f.prefix, TargetType: f.target, TargetLabel: f.label,
		FromTime: e.q.From, ToTime: e.q.To, BeforeCreatedAt: f.beforeAt, BeforeID: f.beforeID, PageSize: int32(f.limit + 1),
	})
	if err != nil {
		return nil, fmt.Errorf("audit: export org events: %w", err)
	}
	return rows, nil
}

// emails looks up the current email of every actor of rows.
func (e *Export) emails(ctx context.Context, rows []db.AuditEvent) (map[uuid.UUID]string, error) {
	seen := make(map[uuid.UUID]bool)
	var ids []uuid.UUID
	for _, r := range rows {
		if r.ActorUserID != nil && !seen[*r.ActorUserID] {
			seen[*r.ActorUserID] = true
			ids = append(ids, *r.ActorUserID)
		}
	}
	out := make(map[uuid.UUID]string, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	us, err := e.r.q.ListUserEmails(ctx, ids)
	if err != nil {
		return nil, fmt.Errorf("audit: export actor emails: %w", err)
	}
	for _, u := range us {
		out[u.ID] = u.Email
	}
	return out, nil
}
