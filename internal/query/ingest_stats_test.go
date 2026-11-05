package query

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/ingest"
)

type fakeIngestStats struct {
	app   uuid.UUID
	days  []time.Time
	byDay map[string]ingest.Counts
}

func (f *fakeIngestStats) Days(_ context.Context, appID uuid.UUID, days []time.Time) ([]ingest.Counts, error) {
	if appID != f.app {
		return nil, errors.New("wrong app")
	}
	f.days = days
	out := make([]ingest.Counts, len(days))
	for i, d := range days {
		out[i] = f.byDay[d.Format(time.DateOnly)]
	}
	return out, nil
}

func TestAppIngestStats(t *testing.T) {
	now := time.Date(2026, 11, 5, 9, 30, 0, 0, time.UTC)
	project, app := uuid.New(), uuid.New()
	cat := &fakeAppStatusCatalog{project: project, app: db.GetProjectAppRow{ID: app, Slug: "storefront"}}
	reader := &fakeIngestStats{app: app, byDay: map[string]ingest.Counts{
		"2026-11-05": {Accepted: 10, Rejected: 1, Truncated: 2, Masked: 3},
		"2026-11-03": {Accepted: 5, Masked: 1},
		"2026-10-01": {Accepted: 99}, // outside the window
	}}
	s := NewService(nil, cat).WithIngestStats(reader)
	s.now = func() time.Time { return now }
	ctx := context.WithValue(context.Background(), principalKey{}, scope{ProjectID: project})

	out, err := s.appIngestStats(ctx, &appIngestStatsInput{ID: app.String(), Days: 3})
	if err != nil {
		t.Fatal(err)
	}
	b := out.Body
	if b.AppID != app.String() || b.App != "storefront" || b.Days != 3 || len(b.Daily) != 3 {
		t.Fatalf("body = %+v", b)
	}
	if b.Daily[0].Date != "2026-11-03" || b.Daily[0].Accepted != 5 || b.Daily[1].Date != "2026-11-04" || b.Daily[1].IngestCounts != (IngestCounts{}) ||
		b.Daily[2].Date != "2026-11-05" || b.Daily[2].Rejected != 1 {
		t.Errorf("daily = %+v", b.Daily)
	}
	if b.Totals != (IngestCounts{Accepted: 15, Rejected: 1, Truncated: 2, Masked: 4}) {
		t.Errorf("totals = %+v", b.Totals)
	}
	if len(reader.days) != 3 || !reader.days[2].Equal(time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)) {
		t.Errorf("read days = %v", reader.days)
	}

	// Out-of-range days are clamped to the retention.
	if out, err = s.appIngestStats(ctx, &appIngestStatsInput{ID: app.String(), Days: 90}); err != nil || out.Body.Days != ingest.StatsRetentionDays {
		t.Errorf("clamped = %+v, %v", out, err)
	}
}

func TestAppIngestStatsErrors(t *testing.T) {
	project, app := uuid.New(), uuid.New()
	cat := &fakeAppStatusCatalog{project: project, app: db.GetProjectAppRow{ID: app}}
	ctx := context.WithValue(context.Background(), principalKey{}, scope{ProjectID: project})
	status := func(s *Service, id string) int {
		_, err := s.appIngestStats(ctx, &appIngestStatsInput{ID: id, Days: 7})
		var se huma.StatusError
		if !errors.As(err, &se) {
			t.Fatalf("err = %v", err)
		}
		return se.GetStatus()
	}
	if got := status(NewService(nil, cat), app.String()); got != http.StatusServiceUnavailable {
		t.Errorf("no reader: %d", got)
	}
	s := NewService(nil, cat).WithIngestStats(&fakeIngestStats{app: app})
	for _, id := range []string{uuid.NewString(), "storefront"} {
		if got := status(s, id); got != http.StatusNotFound {
			t.Errorf("%s: %d, want 404", id, got)
		}
	}
	other := context.WithValue(context.Background(), principalKey{}, scope{ProjectID: uuid.New()})
	if _, err := s.appIngestStats(other, &appIngestStatsInput{ID: app.String(), Days: 7}); err == nil {
		t.Error("other project: want 404")
	}
}
