package query

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/platform/authn"
)

// TestApdexScoreKnownDistribution scores 10 response times against T=500:
// 6 satisfied (<= 500), 3 tolerating (<= 2000) and 1 frustrated, so
// (6 + 3/2) / 10 = 0.75.
func TestApdexScoreKnownDistribution(t *testing.T) {
	const T = 500.0
	latencies := []float64{10, 120, 250, 400, 499, 500, 501, 1500, 2000, 2001}
	var c apdexCounts
	for _, l := range latencies {
		c.requests++
		switch {
		case l <= T:
			c.satisfied++
		case l <= 4*T:
			c.tolerating++
		}
	}
	if c.satisfied != 6 || c.tolerating != 3 {
		t.Fatalf("counts = %+v", c)
	}
	if got := c.score(); got == nil || *got != 0.75 {
		t.Fatalf("score = %v, want 0.75", got)
	}
	for _, tc := range []struct {
		c    apdexCounts
		want float64
	}{
		{apdexCounts{requests: 4, satisfied: 4}, 1},
		{apdexCounts{requests: 4}, 0},
		{apdexCounts{requests: 4, tolerating: 4}, 0.5},
		{apdexCounts{requests: 3, satisfied: 1, tolerating: 1}, 0.5},
		{apdexCounts{requests: 3, satisfied: 2}, 0.67},
	} {
		if got := tc.c.score(); got == nil || *got != tc.want {
			t.Errorf("score(%+v) = %v, want %v", tc.c, got, tc.want)
		}
	}
	if got := (apdexCounts{}).score(); got != nil {
		t.Fatalf("score without requests = %v, want nil", *got)
	}
}

// TestApdexThresholdPrecedence checks the threshold expression resolves an
// endpoint's own threshold before its app's, and its app's before 500 ms.
func TestApdexThresholdPrecedence(t *testing.T) {
	if expr, args := (apdexThresholds{}).expr(); expr != "500" || len(args) != 0 {
		t.Fatalf("default expr = %q %v", expr, args)
	}
	app := uuid.New()
	th := apdexThresholds{
		endpoints: []endpointThreshold{{endpointKey{app: app, method: "GET", path: "/orders/{id}"}, 1000}},
		apps:      []appThreshold{{app: app, ms: 250}},
	}
	expr, args := th.expr()
	want := "multiIf(app_id = ? AND method = ? AND path = ?, 1000, app_id = ?, 250, 500)"
	if expr != want {
		t.Fatalf("expr = %q, want %q", expr, want)
	}
	if len(args) != 4 || args[0] != app || args[1] != "GET" || args[2] != "/orders/{id}" || args[3] != app {
		t.Fatalf("args = %v", args)
	}
	if strings.Count(expr, "?") != len(args) {
		t.Fatalf("placeholders and args differ: %q %v", expr, args)
	}
}

type fakeAppSettingsCatalog struct {
	fakeSettingsCatalog
	threshold *int32
}

func (f *fakeAppSettingsCatalog) GetAppSettings(_ context.Context, arg db.GetAppSettingsParams) (db.GetAppSettingsRow, error) {
	if arg.ID != f.app.ID || arg.ProjectID != f.project {
		return db.GetAppSettingsRow{}, pgx.ErrNoRows
	}
	return db.GetAppSettingsRow{ID: arg.ID, LatencyThresholdMs: f.threshold}, nil
}

func (f *fakeAppSettingsCatalog) UpdateAppLatencyThreshold(_ context.Context, arg db.UpdateAppLatencyThresholdParams) (db.UpdateAppLatencyThresholdRow, error) {
	if arg.ID != f.app.ID {
		return db.UpdateAppLatencyThresholdRow{}, pgx.ErrNoRows
	}
	f.threshold = arg.LatencyThresholdMs
	return db.UpdateAppLatencyThresholdRow{ID: arg.ID, LatencyThresholdMs: f.threshold}, nil
}

func TestAppSettings(t *testing.T) {
	project, app, admin, member := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	cat := &fakeAppSettingsCatalog{fakeSettingsCatalog: fakeSettingsCatalog{
		fakeAppStatusCatalog: fakeAppStatusCatalog{project: project, app: db.GetProjectAppRow{ID: app, Slug: "storefront"}},
		projectSlug:          "shop",
		rows:                 map[endpointKey]db.EndpointSetting{},
	}}
	s := NewService(nil, cat)
	projects := adminProjects{admin: admin, project: project}
	readCtx := context.WithValue(context.Background(), principalKey{}, scope{ProjectID: project})
	userCtx := func(id uuid.UUID) context.Context {
		return authn.WithPrincipal(context.Background(), authn.Principal{Kind: authn.KindUser, UserID: id})
	}

	got, err := s.getAppSettings(readCtx, &getAppSettingsInput{ID: app.String()})
	if err != nil {
		t.Fatal(err)
	}
	if b := got.Body; b.LatencyThresholdMs != nil || b.ApdexThresholdMs != 500 || b.AppID != app.String() {
		t.Fatalf("defaults = %+v", b)
	}
	other := context.WithValue(context.Background(), principalKey{}, scope{ProjectID: uuid.New()})
	if _, err := s.getAppSettings(other, &getAppSettingsInput{ID: app.String()}); statusOf(err) != http.StatusNotFound {
		t.Fatalf("other project read = %v, want 404", err)
	}

	put := &putAppSettingsInput{ID: app.String()}
	ms := 250
	put.Body.LatencyThresholdMs = &ms
	if _, err := s.putAppSettings(userCtx(member), projects, put); statusOf(err) != http.StatusForbidden {
		t.Fatalf("member write = %v, want 403", err)
	}
	if _, err := s.putAppSettings(readCtx, projects, put); statusOf(err) != http.StatusUnauthorized {
		t.Fatalf("read key write = %v, want 401", err)
	}
	if _, err := s.putAppSettings(userCtx(admin), nil, put); statusOf(err) != http.StatusServiceUnavailable {
		t.Fatalf("no authorizer = %v, want 503", err)
	}
	out, err := s.putAppSettings(userCtx(admin), projects, put)
	if err != nil {
		t.Fatal(err)
	}
	if b := out.Body; b.LatencyThresholdMs == nil || *b.LatencyThresholdMs != 250 || b.ApdexThresholdMs != 250 {
		t.Fatalf("saved = %+v", b)
	}
	zero := 0
	put.Body.LatencyThresholdMs = &zero
	if _, err := s.putAppSettings(userCtx(admin), projects, put); statusOf(err) != http.StatusUnprocessableEntity {
		t.Fatalf("zero threshold = %v, want 422", err)
	}
	put.Body.LatencyThresholdMs = nil
	if out, err = s.putAppSettings(userCtx(admin), projects, put); err != nil || out.Body.LatencyThresholdMs != nil || out.Body.ApdexThresholdMs != 500 {
		t.Fatalf("reset = %v %+v", err, out)
	}
	if _, err := s.putAppSettings(userCtx(admin), projects, &putAppSettingsInput{ID: uuid.NewString()}); statusOf(err) != http.StatusNotFound {
		t.Fatalf("unknown app = %v, want 404", err)
	}
}
