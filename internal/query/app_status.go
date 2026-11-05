package query

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/platform/server"
)

// AppStatusPath is the path of an app's reporting status.
const AppStatusPath = server.APIPrefix + "/apps/{id}/status"

// ReportingWindow is how long after its last heartbeat an app, environment or
// instance counts as reporting. SDKs send a heartbeat every 60 seconds, so
// one missed beat is tolerated.
const ReportingWindow = 2 * time.Minute

// StaleWindow is how long after its last heartbeat an app, environment or
// instance counts as stale; past it, it is silent.
const StaleWindow = time.Hour

// maxStatusInstances caps the instances listed by app status.
const maxStatusInstances = 100

// Reporting states of an app, environment or instance.
const (
	StatusReporting = "reporting"
	StatusStale     = "stale"
	StatusSilent    = "silent"
	StatusNever     = "never"
)

// AppStatusStore is the control-plane subset app status reads; *db.Queries
// satisfies it. The Service's Catalog must implement it too, or app status
// answers 503.
type AppStatusStore interface {
	GetProjectApp(ctx context.Context, arg db.GetProjectAppParams) (db.GetProjectAppRow, error)
	ListAppEnvironmentsLastSeen(ctx context.Context, arg db.ListAppEnvironmentsLastSeenParams) ([]db.ListAppEnvironmentsLastSeenRow, error)
	ListRecentAppInstances(ctx context.Context, arg db.ListRecentAppInstancesParams) ([]db.ListRecentAppInstancesRow, error)
}

// AppEnvironmentStatus is the reporting state of an app in one environment.
type AppEnvironmentStatus struct {
	Environment   string    `json:"environment" doc:"Environment name the heartbeats reported."`
	Status        string    `json:"status" enum:"reporting,stale,silent" doc:"reporting when a heartbeat arrived in the last 2 minutes, stale in the last hour, silent when older."`
	LastSeenAt    time.Time `json:"last_seen_at" doc:"Time of the last heartbeat in the environment."`
	LiveInstances int       `json:"live_instances" doc:"Instances that sent a heartbeat in the last 2 minutes."`
}

// AppInstance is one SDK process of an app, as its last heartbeat reported it.
type AppInstance struct {
	Environment      string         `json:"environment" doc:"Environment the instance reports from."`
	InstanceID       string         `json:"instance_id" doc:"Instance id the SDK generated for its process."`
	Status           string         `json:"status" enum:"reporting,stale,silent" doc:"reporting when the instance sent a heartbeat in the last 2 minutes, stale in the last hour, silent when older."`
	SDKName          string         `json:"sdk_name" doc:"SDK package name, e.g. apilenss, apilens-js-sdk, apilens-java-sdk."`
	SDKVersion       string         `json:"sdk_version" doc:"SDK version the instance runs."`
	SDKLatestVersion string         `json:"sdk_latest_version" doc:"Latest released version of the SDK; empty for an SDK APILens does not publish."`
	SDKOutdated      bool           `json:"sdk_outdated" doc:"Whether sdk_version is older than sdk_latest_version."`
	Runtime          string         `json:"runtime" doc:"Language runtime and version, e.g. python 3.13.1."`
	Release          string         `json:"release" doc:"Release of the app the instance runs; empty when not configured."`
	Commit           string         `json:"commit" doc:"Commit of the app the instance runs; empty when not configured."`
	PID              *int64         `json:"pid" required:"true" nullable:"true" doc:"Operating-system process id; null when the SDK did not send one."`
	Stats            map[string]any `json:"stats" doc:"SDK counters as the last heartbeat sent them."`
	FirstSeenAt      time.Time      `json:"first_seen_at" doc:"Time of the instance's first heartbeat."`
	LastSeenAt       time.Time      `json:"last_seen_at" doc:"Time of the instance's last heartbeat."`
}

// AppSDK is one SDK in use by an app, against its latest release.
type AppSDK struct {
	Name              string   `json:"name" doc:"sdk_name the heartbeats sent."`
	Versions          []string `json:"versions" doc:"Versions in use by the listed instances, ascending."`
	LatestVersion     string   `json:"latest_version" doc:"Latest released version; empty for an SDK APILens does not publish."`
	OutdatedInstances int      `json:"outdated_instances" doc:"Listed instances running a version older than latest_version."`
}

// AppSDKStats sums the SDK delivery counters of an app's instances.
type AppSDKStats struct {
	Instances      int              `json:"instances" doc:"Instances summed: those that sent a heartbeat in the last hour."`
	QueuedRecords  int64            `json:"queued_records" doc:"Records waiting in the SDK queues."`
	SentRecords    int64            `json:"sent_records" doc:"Records delivered since each process started."`
	FailedBatches  int64            `json:"failed_batches" doc:"Batches that failed to send since each process started."`
	DroppedRecords int64            `json:"dropped_records" doc:"Records the SDKs dropped since each process started (queue full, rejected, ...)."`
	DropCounts     map[string]int64 `json:"drop_counts" doc:"dropped_records by reason, as the SDKs name them."`
}

// AppStatus says whether an app's SDKs are reporting (sending heartbeats).
type AppStatus struct {
	AppID        string                 `json:"app_id" format:"uuid" doc:"The app's id."`
	App          string                 `json:"app" doc:"The app's slug."`
	Status       string                 `json:"status" enum:"reporting,stale,silent,never" doc:"reporting when any instance sent a heartbeat in the last 2 minutes, stale in the last hour, silent when the last one is older, never when none arrived."`
	LastSeenAt   *time.Time             `json:"last_seen_at" required:"true" nullable:"true" doc:"Time of the last heartbeat; null when none arrived."`
	Environments []AppEnvironmentStatus `json:"environments" doc:"Reporting state per environment the app sent heartbeats from, by name."`
	Instances    []AppInstance          `json:"instances" doc:"The 100 most recently seen instances, newest first."`
	SDKs         []AppSDK               `json:"sdks" doc:"SDKs in use by the listed instances, by name."`
	SDKStats     AppSDKStats            `json:"sdk_stats" doc:"SDK delivery counters summed over the instances seen in the last hour."`
	IngestToday  *IngestCounts          `json:"ingest_today,omitempty" doc:"The ingest edge's counters of the app for the current UTC day (see /apps/{id}/ingest-stats); left out when the counter store is not configured."`
}

type appStatusInput struct {
	ProjectInput
	ID string `path:"id" format:"uuid" doc:"The app's id."`
}

type appStatusOutput struct {
	Body AppStatus
}

func registerAppStatus(api huma.API, s *Service) {
	huma.Register(api, huma.Operation{
		OperationID: "get-app-status",
		Method:      http.MethodGet,
		Path:        AppStatusPath,
		Summary:     "Whether an app's SDKs are reporting",
		Description: "Reporting state of the app from SDK heartbeats (POST /v1/heartbeat): overall, per environment and per instance, " +
			"the SDK versions in use against the latest releases, summed SDK delivery counters (drops) and today's ingest counters. " +
			"An app is reporting while a heartbeat arrived in the last 2 minutes, stale up to an hour, then silent. " +
			"An app that is not in the project answers 404.",
		Tags:     []string{"Dashboard"},
		Security: security,
	}, s.appStatus)
}

func reportingState(now, lastSeen time.Time) string {
	switch age := now.Sub(lastSeen); {
	case age <= ReportingWindow:
		return StatusReporting
	case age <= StaleWindow:
		return StatusStale
	default:
		return StatusSilent
	}
}

func (s *Service) appStatus(ctx context.Context, in *appStatusInput) (*appStatusOutput, error) {
	p, err := principalFrom(ctx)
	if err != nil {
		return nil, err
	}
	store, ok := s.catalog.(AppStatusStore)
	if !ok {
		return nil, huma.Error503ServiceUnavailable("app status unavailable")
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
	now := s.now().UTC()
	envs, err := store.ListAppEnvironmentsLastSeen(ctx, db.ListAppEnvironmentsLastSeenParams{AppID: app.ID, Since: now.Add(-ReportingWindow)})
	if err != nil {
		return nil, internalError("app environments", err)
	}
	instances, err := store.ListRecentAppInstances(ctx, db.ListRecentAppInstancesParams{AppID: app.ID, MaxRows: maxStatusInstances})
	if err != nil {
		return nil, internalError("app instances", err)
	}

	out := &appStatusOutput{Body: AppStatus{
		AppID: app.ID.String(), App: app.Slug, Status: StatusNever,
		Environments: make([]AppEnvironmentStatus, 0, len(envs)),
		Instances:    make([]AppInstance, 0, len(instances)),
		SDKs:         []AppSDK{},
		SDKStats:     AppSDKStats{DropCounts: map[string]int64{}},
	}}
	for _, e := range envs {
		last := e.LastSeenAt.UTC()
		out.Body.Environments = append(out.Body.Environments, AppEnvironmentStatus{
			Environment: e.Environment, Status: reportingState(now, last), LastSeenAt: last, LiveInstances: int(e.LiveInstances),
		})
		if out.Body.LastSeenAt == nil || last.After(*out.Body.LastSeenAt) {
			out.Body.LastSeenAt = &last
		}
	}
	if out.Body.LastSeenAt != nil {
		out.Body.Status = reportingState(now, *out.Body.LastSeenAt)
	}
	sdks := map[string]*AppSDK{}
	for _, i := range instances {
		stats := map[string]any{}
		if len(i.Stats) > 0 {
			if err := json.Unmarshal(i.Stats, &stats); err != nil {
				return nil, internalError("app instance stats", err)
			}
		}
		state := reportingState(now, i.LastSeenAt)
		latest := latestSDKVersion(i.SdkName)
		outdated := sdkOutdated(i.SdkVersion, latest)
		out.Body.Instances = append(out.Body.Instances, AppInstance{
			Environment: i.Environment, InstanceID: i.InstanceID, Status: state,
			SDKName: i.SdkName, SDKVersion: i.SdkVersion, SDKLatestVersion: latest, SDKOutdated: outdated,
			Runtime: i.Runtime, Release: i.Release, Commit: i.Commit,
			PID: i.Pid, Stats: stats, FirstSeenAt: i.FirstSeenAt.UTC(), LastSeenAt: i.LastSeenAt.UTC(),
		})
		if i.SdkName != "" {
			sdk := sdks[i.SdkName]
			if sdk == nil {
				sdk = &AppSDK{Name: i.SdkName, Versions: []string{}, LatestVersion: latest}
				sdks[i.SdkName] = sdk
			}
			if i.SdkVersion != "" && !slices.Contains(sdk.Versions, i.SdkVersion) {
				sdk.Versions = append(sdk.Versions, i.SdkVersion)
			}
			if outdated {
				sdk.OutdatedInstances++
			}
		}
		if state != StatusSilent {
			out.Body.SDKStats.add(i.Stats)
		}
	}
	for _, sdk := range sdks {
		slices.SortFunc(sdk.Versions, compareVersions)
		out.Body.SDKs = append(out.Body.SDKs, *sdk)
	}
	slices.SortFunc(out.Body.SDKs, func(a, b AppSDK) int { return cmp.Compare(a.Name, b.Name) })

	if s.ingestStats != nil {
		counts, err := s.ingestStats.Days(ctx, app.ID, []time.Time{now.Truncate(24 * time.Hour)})
		if err != nil {
			return nil, internalError("ingest stats", err)
		}
		if len(counts) == 1 {
			today := ingestCounts(counts[0])
			out.Body.IngestToday = &today
		}
	}
	return out, nil
}

// add sums one instance's heartbeat stats into t. Counters that are missing,
// not integers or out of range are skipped: stats are whatever the SDK sent.
func (t *AppSDKStats) add(raw []byte) {
	t.Instances++
	var st struct {
		QueuedRecords json.Number            `json:"queued_records"`
		SentRecords   json.Number            `json:"sent_records"`
		FailedBatches json.Number            `json:"failed_batches"`
		Dropped       json.Number            `json:"dropped"`
		DropCounts    map[string]json.Number `json:"drop_counts"`
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if len(raw) == 0 || dec.Decode(&st) != nil {
		return
	}
	t.QueuedRecords += counter(st.QueuedRecords)
	t.SentRecords += counter(st.SentRecords)
	t.FailedBatches += counter(st.FailedBatches)
	t.DroppedRecords += counter(st.Dropped)
	for reason, n := range st.DropCounts {
		if c := counter(n); c > 0 {
			t.DropCounts[reason] += c
		}
	}
}

func counter(n json.Number) int64 {
	v, err := n.Int64()
	if err != nil || v < 0 {
		return 0
	}
	return v
}

// compareVersions orders SDK versions: parsable ones by precedence, then the
// rest as strings.
func compareVersions(a, b string) int {
	switch {
	case a == b:
		return 0
	case sdkOutdated(a, b):
		return -1
	case sdkOutdated(b, a):
		return 1
	}
	return cmp.Compare(a, b)
}
