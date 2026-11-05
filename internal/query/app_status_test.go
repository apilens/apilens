package query

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/controlplane/store/db"
)

type fakeAppStatusCatalog struct {
	project   uuid.UUID
	app       db.GetProjectAppRow
	envs      []db.ListAppEnvironmentsLastSeenRow
	instances []db.ListRecentAppInstancesRow
	since     time.Time
}

func (f *fakeAppStatusCatalog) GetProjectWithOrg(context.Context, uuid.UUID) (db.GetProjectWithOrgRow, error) {
	return db.GetProjectWithOrgRow{}, errors.New("unused")
}

func (f *fakeAppStatusCatalog) ListProjectApps(context.Context, uuid.UUID) ([]db.ListProjectAppsRow, error) {
	return nil, errors.New("unused")
}

func (f *fakeAppStatusCatalog) GetProjectApp(_ context.Context, arg db.GetProjectAppParams) (db.GetProjectAppRow, error) {
	if arg.ID != f.app.ID || arg.ProjectID != f.project {
		return db.GetProjectAppRow{}, pgx.ErrNoRows
	}
	return f.app, nil
}

func (f *fakeAppStatusCatalog) ListAppEnvironmentsLastSeen(_ context.Context, arg db.ListAppEnvironmentsLastSeenParams) ([]db.ListAppEnvironmentsLastSeenRow, error) {
	f.since = arg.Since
	return f.envs, nil
}

func (f *fakeAppStatusCatalog) ListRecentAppInstances(context.Context, db.ListRecentAppInstancesParams) ([]db.ListRecentAppInstancesRow, error) {
	return f.instances, nil
}

func TestAppStatus(t *testing.T) {
	now := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	project, app := uuid.New(), uuid.New()
	pid := int64(42)
	cat := &fakeAppStatusCatalog{project: project, app: db.GetProjectAppRow{ID: app, Slug: "storefront"}}
	s := NewService(nil, cat)
	s.now = func() time.Time { return now }
	ctx := context.WithValue(context.Background(), principalKey{}, scope{ProjectID: project})

	// No heartbeat yet.
	out, err := s.appStatus(ctx, &appStatusInput{ID: app.String()})
	if err != nil {
		t.Fatal(err)
	}
	if out.Body.Status != StatusNever || out.Body.LastSeenAt != nil || len(out.Body.Environments) != 0 || len(out.Body.Instances) != 0 {
		t.Fatalf("never = %+v", out.Body)
	}
	if !cat.since.Equal(now.Add(-ReportingWindow)) {
		t.Errorf("since = %v", cat.since)
	}

	// One environment reporting, one stale.
	cat.envs = []db.ListAppEnvironmentsLastSeenRow{
		{Environment: "production", LastSeenAt: now.Add(-30 * time.Second), LiveInstances: 2},
		{Environment: "staging", LastSeenAt: now.Add(-time.Hour)},
	}
	cat.instances = []db.ListRecentAppInstancesRow{
		{Environment: "production", InstanceID: "a", SdkName: "apilenss", Pid: &pid, Stats: []byte(`{"sent":3}`), FirstSeenAt: now.Add(-time.Hour), LastSeenAt: now.Add(-30 * time.Second)},
		{Environment: "staging", InstanceID: "b", Stats: []byte(`{}`), FirstSeenAt: now.Add(-2 * time.Hour), LastSeenAt: now.Add(-time.Hour)},
	}
	out, err = s.appStatus(ctx, &appStatusInput{ID: app.String()})
	if err != nil {
		t.Fatal(err)
	}
	b := out.Body
	if b.Status != StatusReporting || b.LastSeenAt == nil || !b.LastSeenAt.Equal(now.Add(-30*time.Second)) || b.App != "storefront" || b.AppID != app.String() {
		t.Fatalf("status = %+v", b)
	}
	if len(b.Environments) != 2 || b.Environments[0].Status != StatusReporting || b.Environments[0].LiveInstances != 2 || b.Environments[1].Status != StatusStale {
		t.Errorf("environments = %+v", b.Environments)
	}
	if len(b.Instances) != 2 || b.Instances[0].Status != StatusReporting || b.Instances[0].Stats["sent"] != float64(3) ||
		*b.Instances[0].PID != 42 || b.Instances[1].Status != StatusStale {
		t.Errorf("instances = %+v", b.Instances)
	}

	// Only stale environments: stale.
	cat.envs = cat.envs[1:]
	if out, err = s.appStatus(ctx, &appStatusInput{ID: app.String()}); err != nil || out.Body.Status != StatusStale {
		t.Errorf("stale = %+v, %v", out, err)
	}
}

func TestAppStatusNotFound(t *testing.T) {
	project, app := uuid.New(), uuid.New()
	s := NewService(nil, &fakeAppStatusCatalog{project: project, app: db.GetProjectAppRow{ID: app}})
	for _, c := range []struct {
		name    string
		project uuid.UUID
		id      string
	}{
		{"other project", uuid.New(), app.String()},
		{"unknown app", project, uuid.NewString()},
		{"not a uuid", project, "storefront"},
	} {
		ctx := context.WithValue(context.Background(), principalKey{}, scope{ProjectID: c.project})
		_, err := s.appStatus(ctx, &appStatusInput{ID: c.id})
		var se huma.StatusError
		if !errors.As(err, &se) || se.GetStatus() != http.StatusNotFound {
			t.Errorf("%s: err = %v, want 404", c.name, err)
		}
	}
}
