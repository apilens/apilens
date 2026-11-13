package api

import (
	"bufio"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/auditlog"
	"github.com/apilens/apilens/internal/identity"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/server"
)

// Audit event export paths.
const (
	ProjectAuditExportPath = ProjectAuditEventsPath + "/export"
	OrgAuditExportPath     = OrgAuditEventsPath + "/export"
)

// TruncatedHeader is set to "true" on an export capped at
// audit.MaxExportRows.
const TruncatedHeader = "X-Truncated"

// auditCSVColumns is the header row of a CSV audit export.
var auditCSVColumns = []string{
	"timestamp", "action", "actor_id", "actor_name", "actor_email", "ip", "user_agent", "request_id",
	"target_type", "target_id", "target_label", "project", "previous", "next",
}

// ExportAuditEventsQuery are the filters and format of an audit export.
type ExportAuditEventsQuery struct {
	AuditEventFilters
	Format string `query:"format" enum:"csv" default:"csv" doc:"The file format; only csv."`
}

// ExportProjectAuditEventsInput is the request of GET /api/v1/projects/{slug}/audit-events/export.
type ExportProjectAuditEventsInput struct {
	ProjectSlugInput
	ExportAuditEventsQuery
}

// ExportOrgAuditEventsInput is the request of GET /api/v1/orgs/{slug}/audit-events/export.
type ExportOrgAuditEventsInput struct {
	OrgSlugInput
	ExportAuditEventsQuery
}

const auditExportDoc = " Streams a CSV file (`text/csv`, one header row, then one row per event, newest first) with the columns " +
	"timestamp, action, actor_id, actor_name, actor_email, ip, user_agent, request_id, target_type, target_id, target_label, project, previous, next " +
	"(`previous` and `next` are the JSON values of a change). Takes the filters of the listing, without its page; " +
	"at most 100 000 rows, the newest, with the header `X-Truncated: true` when more matched. " +
	"A cell starting with `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with `'` so spreadsheets never run it as a formula. " +
	"The export itself is audited (`audit_log.exported`)."

// registerExport mounts the export operations.
func (a *AuditEvents) registerExport(api huma.API, session []map[string][]string, guard huma.Middlewares) {
	codes := []identity.ErrCode{identity.CodeInvalidRequest, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeNotFound, identity.CodeAuthzUnavailable, identity.CodeInternal}
	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "export-project-audit-events",
		Method:      http.MethodGet,
		Path:        ProjectAuditExportPath,
		Summary:     "Export a project's audit events",
		Description: "Exports the project's audit trail for access reviews." + auditExportDoc +
			" Needs `view_audit` on the project, like the event list.",
		Tags:      []string{server.TagProjects},
		Security:  session,
		Responses: auditExportResponses(),
	}, codes...), a.exportProject)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "export-org-audit-events",
		Method:      http.MethodGet,
		Path:        OrgAuditExportPath,
		Summary:     "Export an organization's audit events",
		Description: "Exports the organization's audit trail for access reviews: its org-wide events and those of the projects the caller can view." + auditExportDoc +
			" Org owners and admins only, like the event list.",
		Tags:        []string{server.TagOrganizations},
		Security:    session,
		Middlewares: guard,
		Responses:   auditExportResponses(),
	}, codes...), a.exportOrg)
}

func auditExportResponses() map[string]*huma.Response {
	return map[string]*huma.Response{
		"200": {
			Description: "The CSV file.",
			Headers: map[string]*huma.Param{
				"Content-Disposition": {Description: "attachment, with a file name.", Schema: &huma.Schema{Type: huma.TypeString}},
				TruncatedHeader:       {Description: "true when more than 100 000 events matched and only the newest 100 000 are in the file; absent otherwise.", Schema: &huma.Schema{Type: huma.TypeString, Enum: []any{"true"}}},
			},
			Content: map[string]*huma.MediaType{"text/csv": {Schema: &huma.Schema{Type: huma.TypeString}}},
		},
	}
}

func (a *AuditEvents) exportProject(ctx context.Context, in *ExportProjectAuditEventsInput) (*huma.StreamResponse, error) {
	t, err := a.authorizeProjectTarget(ctx, in.Slug)
	if err != nil {
		return nil, err
	}
	p, _ := authn.FromContext(ctx)
	r, err := in.request(p.UserID, t.OrgID)
	if err != nil {
		return nil, err
	}
	x, err := a.svc.ExportProject(ctx, t.ProjectID, auditlog.Project{Slug: in.Slug}, r)
	if err != nil {
		return nil, a.problem(ctx, "export project audit events", err)
	}
	return a.stream("apilens-audit-"+in.Slug, x), nil
}

func (a *AuditEvents) exportOrg(ctx context.Context, in *ExportOrgAuditEventsInput) (*huma.StreamResponse, error) {
	p, ok := authn.FromContext(ctx)
	t, tok := authz.TargetFromContext(ctx)
	if !ok || p.Kind != authn.KindUser || !tok {
		return nil, identity.Err(identity.CodeUnauthenticated)
	}
	r, err := in.request(p.UserID, t.OrgID)
	if err != nil {
		return nil, err
	}
	x, err := a.svc.ExportOrg(ctx, r)
	if err != nil {
		return nil, a.problem(ctx, "export org audit events", err)
	}
	return a.stream("apilens-audit-"+in.Slug, x), nil
}

// request validates the filters into the export request of actor in org.
func (in *ExportAuditEventsQuery) request(actor, org uuid.UUID) (auditlog.ExportRequest, error) {
	q, err := in.query()
	if err != nil {
		return auditlog.ExportRequest{}, err
	}
	return auditlog.ExportRequest{
		Actor: actor, Org: org, Format: "csv", Query: q,
		Filters: map[string]string{"actor": in.Actor, "action": in.Action, "target_type": in.TargetType, "from": in.From, "to": in.To, "q": in.Q},
	}, nil
}

// stream writes x as a CSV attachment named name plus the date.
func (a *AuditEvents) stream(name string, x auditlog.Export) *huma.StreamResponse {
	return &huma.StreamResponse{Body: func(hctx huma.Context) {
		ctx := hctx.Context()
		hctx.SetHeader("Content-Type", "text/csv; charset=utf-8")
		hctx.SetHeader("Content-Disposition", `attachment; filename="`+name+"-"+time.Now().UTC().Format("2006-01-02")+`.csv"`)
		hctx.SetHeader("Cache-Control", "no-store")
		if x.Truncated {
			hctx.SetHeader(TruncatedHeader, "true")
		}
		hctx.SetStatus(http.StatusOK)
		if err := writeAuditCSV(ctx, hctx.BodyWriter(), x); err != nil && !errors.Is(err, context.Canceled) {
			// The status is sent: the client sees a short file.
			a.logger.ErrorContext(ctx, "stream audit export", "error", err)
		}
	}}
}

// auditCSVFlushRows is how many rows are buffered before they are flushed to
// the client.
const auditCSVFlushRows = 500

// writeAuditCSV writes the header row and every event of x to w, flushing as
// it goes so memory stays bounded whatever the export's size.
func writeAuditCSV(ctx context.Context, w io.Writer, x auditlog.Export) error {
	bw := bufio.NewWriterSize(w, 32<<10)
	cw := csv.NewWriter(bw)
	flusher, _ := w.(http.Flusher)
	flush := func() error {
		cw.Flush()
		if err := cw.Error(); err != nil {
			return err
		}
		if err := bw.Flush(); err != nil {
			return err
		}
		if flusher != nil {
			flusher.Flush()
		}
		return nil
	}
	if err := cw.Write(auditCSVColumns); err != nil {
		return err
	}
	row := make([]string, len(auditCSVColumns))
	n := 0
	err := x.Each(ctx, func(e auditlog.Entry) error {
		auditCSVRow(row, e)
		if err := cw.Write(row); err != nil {
			return err
		}
		if n++; n%auditCSVFlushRows == 0 {
			return flush()
		}
		return nil
	})
	if ferr := flush(); err == nil {
		err = ferr
	}
	return err
}

// auditCSVRow fills row with e's cells, each guarded against formula
// injection.
func auditCSVRow(row []string, e auditlog.Entry) {
	var actorID, actorName, actorEmail, project, previous, next string
	if e.Actor != nil {
		actorID, actorName, actorEmail = e.Actor.String(), e.ActorLabel, e.ActorEmail
	}
	if e.ProjectRef != nil {
		project = e.ProjectRef.Slug
	}
	if len(e.Changes) > 0 {
		var c struct {
			Previous json.RawMessage `json:"previous"`
			Next     json.RawMessage `json:"next"`
		}
		if json.Unmarshal(e.Changes, &c) == nil {
			previous, next = rawJSON(c.Previous), rawJSON(c.Next)
		}
	}
	cells := [...]string{
		e.Time.UTC().Format(time.RFC3339Nano), e.Kind, actorID, actorName, actorEmail, e.IP, e.UserAgent, e.RequestID,
		e.Target.Type, e.Target.ID, e.Target.Label, project, previous, next,
	}
	for i, c := range cells {
		row[i] = csvSafe(c)
	}
}

// rawJSON is a JSON value as text; "" for an absent or null one.
func rawJSON(m json.RawMessage) string {
	if len(m) == 0 || string(m) == "null" {
		return ""
	}
	return string(m)
}

// csvSafe prefixes a cell that a spreadsheet would run as a formula (it
// starts with =, +, -, @, a tab or a carriage return) with a quote, as the
// OWASP CSV injection guidance says.
func csvSafe(s string) string {
	if s == "" {
		return s
	}
	switch s[0] {
	case '=', '+', '-', '@', '\t', '\r':
		return "'" + s
	}
	return s
}
