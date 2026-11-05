package query

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/ingest"
	"github.com/apilens/apilens/internal/platform/server"
)

// AppIngestStatsPath is the path of an app's ingest health counters.
const AppIngestStatsPath = server.APIPrefix + "/apps/{id}/ingest-stats"

// IngestStatsReader reads the per app and day counters the edge keeps;
// *ingest.ValkeyStats satisfies it.
type IngestStatsReader interface {
	Days(ctx context.Context, appID uuid.UUID, days []time.Time) ([]ingest.Counts, error)
}

// WithIngestStats sets where app ingest-stats reads its counters; without it
// the operation answers 503.
func (s *Service) WithIngestStats(r IngestStatsReader) *Service {
	s.ingestStats = r
	return s
}

// IngestCounts are the edge's health counters of an app over a period.
type IngestCounts struct {
	Accepted  int64 `json:"accepted" doc:"Records stored (requests, logs, spans, deploys)."`
	Rejected  int64 `json:"rejected" doc:"Records refused by the project's ingest quota (429) or dropped as invalid from an OTLP export."`
	Truncated int64 `json:"truncated" doc:"Request record fields (payloads, headers) cut to the server-side cap; a record can count up to four times."`
	Masked    int64 `json:"masked" doc:"Records in which the server-side privacy policy masked at least one value."`
}

// IngestDay is the counters of one UTC day.
type IngestDay struct {
	Date string `json:"date" format:"date" doc:"UTC day, YYYY-MM-DD."`
	IngestCounts
}

// AppIngestStats is the ingest health of an app over the last days.
type AppIngestStats struct {
	AppID  string       `json:"app_id" format:"uuid" doc:"The app's id."`
	App    string       `json:"app" doc:"The app's slug."`
	Days   int          `json:"days" doc:"Number of UTC days covered, today included."`
	Totals IngestCounts `json:"totals" doc:"Sum over the days."`
	Daily  []IngestDay  `json:"daily" doc:"One entry per day, oldest first; a day without traffic is all zero."`
}

type appIngestStatsInput struct {
	ProjectInput
	ID   string `path:"id" format:"uuid" doc:"The app's id."`
	Days int    `query:"days" minimum:"1" maximum:"30" default:"7" doc:"UTC days to cover, today included."`
}

type appIngestStatsOutput struct {
	Body AppIngestStats
}

func registerAppIngestStats(api huma.API, s *Service) {
	huma.Register(api, huma.Operation{
		OperationID: "get-app-ingest-stats",
		Method:      http.MethodGet,
		Path:        AppIngestStatsPath,
		Summary:     "Per-app ingest health: accepted, rejected, truncated and masked records",
		Description: "Counters the ingest edge keeps per app and UTC day, the per-app split of the Prometheus totals " +
			"apilens_ingest_records_total (accepted, rejected), apilens_ingest_truncated_total and apilens_ingest_masked_total. " +
			"Records not tied to an app (project-wide deploys, OTLP resources of unknown services) are not counted. " +
			"Days are kept for 30 days. An app that is not in the project answers 404; 503 when the counter store (Valkey) is not configured.",
		Tags:     []string{"Dashboard"},
		Security: security,
	}, s.appIngestStats)
}

func (s *Service) appIngestStats(ctx context.Context, in *appIngestStatsInput) (*appIngestStatsOutput, error) {
	p, err := principalFrom(ctx)
	if err != nil {
		return nil, err
	}
	store, ok := s.catalog.(AppStatusStore)
	if !ok || s.ingestStats == nil {
		return nil, huma.Error503ServiceUnavailable("ingest stats unavailable")
	}
	id, err := uuid.Parse(in.ID)
	if err != nil {
		return nil, huma.Error404NotFound("app not found")
	}
	app, err := store.GetProjectApp(ctx, db.GetProjectAppParams{ID: id, ProjectID: p.ProjectID})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, huma.Error404NotFound("app not found")
	}
	if err != nil {
		return nil, internalError("app lookup", err)
	}
	n := min(max(in.Days, 1), ingest.StatsRetentionDays)
	today := s.now().UTC().Truncate(24 * time.Hour)
	days := make([]time.Time, n)
	for i := range days {
		days[i] = today.AddDate(0, 0, i-n+1)
	}
	counts, err := s.ingestStats.Days(ctx, app.ID, days)
	if err == nil && len(counts) != n {
		err = fmt.Errorf("got %d days, want %d", len(counts), n)
	}
	if err != nil {
		return nil, internalError("ingest stats", err)
	}
	out := &appIngestStatsOutput{Body: AppIngestStats{AppID: app.ID.String(), App: app.Slug, Days: n, Daily: make([]IngestDay, 0, n)}}
	var total ingest.Counts
	for i, c := range counts {
		total = total.Add(c)
		out.Body.Daily = append(out.Body.Daily, IngestDay{Date: days[i].Format(time.DateOnly), IngestCounts: ingestCounts(c)})
	}
	out.Body.Totals = ingestCounts(total)
	return out, nil
}

func ingestCounts(c ingest.Counts) IngestCounts {
	return IngestCounts{Accepted: c.Accepted, Rejected: c.Rejected, Truncated: c.Truncated, Masked: c.Masked}
}
