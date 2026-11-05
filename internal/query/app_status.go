package query

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
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
// instance counts as reporting. It matches the edge's last-seen key TTL.
const ReportingWindow = 5 * time.Minute

// maxStatusInstances caps the instances listed by app status.
const maxStatusInstances = 100

// Reporting states of an app, environment or instance.
const (
	StatusReporting = "reporting"
	StatusStale     = "stale"
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
	Environment   string    `json:"environment"`
	Status        string    `json:"status" enum:"reporting,stale" doc:"reporting when a heartbeat arrived in the last 5 minutes."`
	LastSeenAt    time.Time `json:"last_seen_at" doc:"Time of the last heartbeat in the environment."`
	LiveInstances int       `json:"live_instances" doc:"Instances that sent a heartbeat in the last 5 minutes."`
}

// AppInstance is one SDK process of an app, as its last heartbeat reported it.
type AppInstance struct {
	Environment string         `json:"environment"`
	InstanceID  string         `json:"instance_id"`
	Status      string         `json:"status" enum:"reporting,stale"`
	SDKName     string         `json:"sdk_name"`
	SDKVersion  string         `json:"sdk_version"`
	Runtime     string         `json:"runtime"`
	Release     string         `json:"release"`
	Commit      string         `json:"commit"`
	PID         *int64         `json:"pid" required:"true" nullable:"true"`
	Stats       map[string]any `json:"stats" doc:"SDK counters as the last heartbeat sent them."`
	FirstSeenAt time.Time      `json:"first_seen_at"`
	LastSeenAt  time.Time      `json:"last_seen_at"`
}

// AppStatus says whether an app's SDKs are reporting (sending heartbeats).
type AppStatus struct {
	AppID        string                 `json:"app_id" format:"uuid"`
	App          string                 `json:"app" doc:"The app's slug."`
	Status       string                 `json:"status" enum:"reporting,stale,never" doc:"reporting when any instance sent a heartbeat in the last 5 minutes, stale when the last one is older, never when none arrived."`
	LastSeenAt   *time.Time             `json:"last_seen_at" required:"true" nullable:"true" doc:"Time of the last heartbeat; null when none arrived."`
	Environments []AppEnvironmentStatus `json:"environments"`
	Instances    []AppInstance          `json:"instances" doc:"The 100 most recently seen instances, newest first."`
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
		Description: "Reporting state of the app from SDK heartbeats (POST /v1/heartbeat): overall, per environment and per instance. " +
			"An app is reporting while a heartbeat arrived in the last 5 minutes. An app that is not in the project answers 404.",
		Tags:     []string{"Dashboard"},
		Security: security,
	}, s.appStatus)
}

func reportingState(now, lastSeen time.Time) string {
	if now.Sub(lastSeen) <= ReportingWindow {
		return StatusReporting
	}
	return StatusStale
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
	for _, i := range instances {
		stats := map[string]any{}
		if len(i.Stats) > 0 {
			if err := json.Unmarshal(i.Stats, &stats); err != nil {
				return nil, internalError("app instance stats", err)
			}
		}
		out.Body.Instances = append(out.Body.Instances, AppInstance{
			Environment: i.Environment, InstanceID: i.InstanceID, Status: reportingState(now, i.LastSeenAt),
			SDKName: i.SdkName, SDKVersion: i.SdkVersion, Runtime: i.Runtime, Release: i.Release, Commit: i.Commit,
			PID: i.Pid, Stats: stats, FirstSeenAt: i.FirstSeenAt.UTC(), LastSeenAt: i.LastSeenAt.UTC(),
		})
	}
	return out, nil
}
