package query

import (
	"context"
	"errors"
	"maps"
	"net/http"
	"slices"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/ingest"
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

func TestAppStatusSilentSDKsAndStats(t *testing.T) {
	now := time.Date(2026, 11, 5, 12, 0, 0, 0, time.UTC)
	project, app := uuid.New(), uuid.New()
	cat := &fakeAppStatusCatalog{project: project, app: db.GetProjectAppRow{ID: app, Slug: "storefront"}}
	reader := &fakeIngestStats{app: app, byDay: map[string]ingest.Counts{"2026-11-05": {Accepted: 9, Rejected: 1}}}
	s := NewService(nil, cat).WithIngestStats(reader)
	s.now = func() time.Time { return now }
	ctx := context.WithValue(context.Background(), principalKey{}, scope{ProjectID: project})

	cat.envs = []db.ListAppEnvironmentsLastSeenRow{
		{Environment: "production", LastSeenAt: now.Add(-3 * time.Minute)},
		{Environment: "staging", LastSeenAt: now.Add(-2 * time.Hour)},
	}
	cat.instances = []db.ListRecentAppInstancesRow{
		{Environment: "production", InstanceID: "a", SdkName: "apilenss", SdkVersion: latestSDKVersion("apilenss"),
			Stats:      []byte(`{"queued_records":2,"sent_records":100,"failed_batches":1,"dropped":5,"drop_counts":{"queue_full":4,"rejected":1,"truncated":7}}`),
			LastSeenAt: now.Add(-3 * time.Minute)},
		{Environment: "production", InstanceID: "b", SdkName: "apilenss", SdkVersion: "0.0.1",
			Stats:      []byte(`{"sent_records":12345678901234567890,"dropped":2,"drop_counts":{"queue_full":2},"last_error":"x"}`),
			LastSeenAt: now.Add(-30 * time.Minute)},
		{Environment: "production", InstanceID: "c", SdkName: "apilens-java-sdk", SdkVersion: "0.0.9", Stats: []byte(`{"dropped":"lots"}`),
			LastSeenAt: now.Add(-50 * time.Minute)},
		{Environment: "staging", InstanceID: "d", SdkName: "custom-sdk", SdkVersion: "9.9.9", Stats: []byte(`{"dropped":1000}`),
			LastSeenAt: now.Add(-2 * time.Hour)},
	}
	out, err := s.appStatus(ctx, &appStatusInput{ID: app.String()})
	if err != nil {
		t.Fatal(err)
	}
	b := out.Body
	if b.Status != StatusStale || b.Environments[0].Status != StatusStale || b.Environments[1].Status != StatusSilent {
		t.Errorf("status = %s, environments = %+v", b.Status, b.Environments)
	}
	if b.Instances[0].Status != StatusStale || b.Instances[3].Status != StatusSilent {
		t.Errorf("instance states = %s, %s", b.Instances[0].Status, b.Instances[3].Status)
	}
	if in := b.Instances[0]; in.SDKOutdated || in.SDKLatestVersion != latestSDKVersion("apilenss") {
		t.Errorf("current instance = %+v", in)
	}
	if in := b.Instances[1]; !in.SDKOutdated || in.SDKLatestVersion == "" {
		t.Errorf("outdated instance = %+v", in)
	}
	if in := b.Instances[3]; in.SDKOutdated || in.SDKLatestVersion != "" {
		t.Errorf("unknown sdk instance = %+v", in)
	}
	if len(b.SDKs) != 3 || b.SDKs[0].Name != "apilens-java-sdk" || b.SDKs[0].OutdatedInstances != 1 ||
		b.SDKs[1].Name != "apilenss" || !slices.Equal(b.SDKs[1].Versions, []string{"0.0.1", latestSDKVersion("apilenss")}) ||
		b.SDKs[1].OutdatedInstances != 1 || b.SDKs[2].Name != "custom-sdk" || b.SDKs[2].LatestVersion != "" {
		t.Errorf("sdks = %+v", b.SDKs)
	}
	// The silent instance is left out; counters that are not int64 are skipped.
	st := b.SDKStats
	if st.Instances != 3 || st.QueuedRecords != 2 || st.SentRecords != 100 || st.FailedBatches != 1 || st.DroppedRecords != 7 ||
		!maps.Equal(st.DropCounts, map[string]int64{"queue_full": 6, "rejected": 1, "truncated": 7}) {
		t.Errorf("sdk stats = %+v", st)
	}
	if b.IngestToday == nil || b.IngestToday.Accepted != 9 || b.IngestToday.Rejected != 1 {
		t.Errorf("ingest today = %+v", b.IngestToday)
	}
	if len(reader.days) != 1 || !reader.days[0].Equal(time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)) {
		t.Errorf("ingest days = %v", reader.days)
	}

	// Everything older than an hour: silent. No counter store: no ingest counts.
	cat.envs = cat.envs[1:]
	s.ingestStats = nil
	if out, err = s.appStatus(ctx, &appStatusInput{ID: app.String()}); err != nil || out.Body.Status != StatusSilent || out.Body.IngestToday != nil {
		t.Errorf("silent = %+v, %v", out, err)
	}
}

func TestSDKOutdated(t *testing.T) {
	for _, c := range []struct {
		version, latest string
		want            bool
	}{
		{"0.4.0", "0.5.0", true},
		{"0.5.0", "0.5.0", false},
		{"v0.5.0", "0.5.0", false},
		{"0.10.0", "0.9.0", false},
		{"0.9.9", "0.10.0", true},
		{"1.0.0", "0.10.0", false},
		{"0.5.0-rc.1", "0.5.0", true},
		{"0.5.0+build", "0.5.0", false},
		{"0.5.1-rc.1", "0.5.0", false},
		{"dev", "0.5.0", false},
		{"0.5", "0.5.0", false},
		{"0.4.0", "", false},
	} {
		if got := sdkOutdated(c.version, c.latest); got != c.want {
			t.Errorf("sdkOutdated(%q, %q) = %v, want %v", c.version, c.latest, got, c.want)
		}
	}
}

func TestSDKLatestCoversOurSDKs(t *testing.T) {
	for _, name := range []string{"apilenss", "apilens-js-sdk", "apilens-java-sdk"} {
		if _, _, ok := parseVersion(latestSDKVersion(name)); !ok {
			t.Errorf("latest %s = %q", name, latestSDKVersion(name))
		}
	}
}
