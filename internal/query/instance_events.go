package query

import (
	"cmp"
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/platform/server"
)

// AppInstanceEventsPath is the path of an app's restarts and OOM kills.
const AppInstanceEventsPath = server.APIPrefix + "/apps/{id}/instance-events"

// maxInstanceEvents caps the events of one response.
const maxInstanceEvents = 1000

// InstanceEventsStore is the control-plane subset instance events read;
// *db.Queries satisfies it.
type InstanceEventsStore interface {
	AppStore
	ListAppInstanceEvents(ctx context.Context, arg db.ListAppInstanceEventsParams) ([]db.ListAppInstanceEventsRow, error)
}

// InstanceEvent is a restart or OOM kill of an SDK process, a chart marker.
type InstanceEvent struct {
	Kind        string         `json:"kind" enum:"restart,oom,suspected_oom,oom_kill" doc:"oom_kill: a live process reported its container's OOM killer fired (details.count); restart: a process ended and was replaced, cause unknown; oom: it ended after its container recorded an OOM kill; suspected_oom: it ended with its container at 90 % or more of its memory limit."`
	At          time.Time      `json:"at" doc:"When the event was recorded."`
	Environment string         `json:"environment" doc:"Environment of the instance."`
	InstanceID  string         `json:"instance_id" doc:"The SDK process the event is about (for restarts, the one that ended)."`
	ContainerID string         `json:"container_id" doc:"Container of the instance; empty when unknown."`
	PodName     string         `json:"pod_name" doc:"Kubernetes pod of the instance; empty outside Kubernetes."`
	Details     map[string]any `json:"details" doc:"Kind-specific details: count for oom_kill; replaced_by and last_seen_at for the ends."`
}

type instanceEventsInput struct {
	ProjectInput
	ID          string `path:"id" format:"uuid" doc:"The app's id."`
	Range       string `query:"range" enum:"1h,6h,24h,7d,30d" default:"24h" doc:"Time range ending now."`
	Environment string `query:"environment" maxLength:"64" doc:"Environment name; empty means all."`
	Env         string `query:"env" maxLength:"64" doc:"Alias of environment, as the traffic operations name it."`
}

type instanceEventsOutput struct {
	Body struct {
		Range  string          `json:"range" doc:"Time range of the response."`
		From   time.Time       `json:"from" doc:"Start of the window (inclusive)."`
		To     time.Time       `json:"to" doc:"End of the window (exclusive)."`
		Events []InstanceEvent `json:"events" doc:"Events of the window, newest first, at most 1000."`
	}
}

func registerInstanceEvents(api huma.API, s *Service) {
	huma.Register(api, huma.Operation{
		OperationID: "list-app-instance-events",
		Method:      http.MethodGet,
		Path:        AppInstanceEventsPath,
		Summary:     "Restarts and OOM kills of an app's instances",
		Description: "Restarts, OOM kills and suspected OOMs of the app's SDK processes in the window, inferred from heartbeats " +
			"(a new process in the same container or pod ends the previous one), for markers on the resources charts. " +
			"An app that is not in the project answers 404." + readAccess,
		Tags:     []string{"Dashboard"},
		Security: security,
	}, s.instanceEvents)
}

func (s *Service) instanceEvents(ctx context.Context, in *instanceEventsInput) (*instanceEventsOutput, error) {
	_, app, err := s.projectApp(ctx, in.ID)
	if err != nil {
		return nil, err
	}
	store, ok := s.catalog.(InstanceEventsStore)
	if !ok {
		return nil, huma.Error503ServiceUnavailable("instance events unavailable")
	}
	w, err := resolveResourceWindow(in.Range, s.now())
	if err != nil {
		return nil, err
	}
	rows, err := store.ListAppInstanceEvents(ctx, db.ListAppInstanceEventsParams{
		AppID: app.ID, Environment: cmp.Or(in.Environment, in.Env), Since: w.from, Until: w.to, MaxRows: maxInstanceEvents,
	})
	if err != nil {
		return nil, internalError("instance events", err)
	}
	out := &instanceEventsOutput{}
	out.Body.Range, out.Body.From, out.Body.To = w.name, w.from, w.to
	out.Body.Events = make([]InstanceEvent, 0, len(rows))
	for _, r := range rows {
		details := map[string]any{}
		if len(r.Details) > 0 {
			if err := json.Unmarshal(r.Details, &details); err != nil {
				return nil, internalError("instance event details", err)
			}
		}
		out.Body.Events = append(out.Body.Events, InstanceEvent{
			Kind: r.Kind, At: r.At.UTC(), Environment: r.Environment, InstanceID: r.InstanceID,
			ContainerID: r.ContainerID, PodName: r.PodName, Details: details,
		})
	}
	return out, nil
}
