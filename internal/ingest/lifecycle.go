package ingest

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/controlplane/store/db"
)

// InstanceLifecycle infers restarts and OOM kills (M7, ADR 0010 D10). A
// process the OOM killer took cannot report its own end, but the next process
// in its pod or container can; *db.Queries satisfies it. A HeartbeatStore that
// also implements it gets the inference.
type InstanceLifecycle interface {
	RecordOOMKill(ctx context.Context, arg db.RecordOOMKillParams) error
	EndReplacedInstances(ctx context.Context, arg db.EndReplacedInstancesParams) ([]db.EndReplacedInstancesRow, error)
	RecordInstanceEnded(ctx context.Context, arg db.RecordInstanceEndedParams) error
}

// inferLifecycle runs after the heartbeat of instance is stored. It is best
// effort: a failure is logged and never fails the heartbeat.
func (e *Edge) inferLifecycle(ctx context.Context, project, app uuid.UUID, env, instance string, at time.Time, ident Identity, s ResourceSample) {
	lc, ok := e.heartbeats.(InstanceLifecycle)
	if !ok {
		return
	}
	container := s.ContainerID
	if container == "" {
		container = ident.ContainerID
	}
	if container == "" && ident.PodUID == "" {
		return // nothing ties this process to an earlier one
	}
	if n := s.Metrics["container.memory.oom_kill"]; n > 0 && container != "" {
		if err := lc.RecordOOMKill(ctx, db.RecordOOMKillParams{
			ProjectID: project, AppID: app, Environment: env, InstanceID: instance,
			ContainerID: container, PodName: ident.PodName, At: at, Count: n,
		}); err != nil {
			e.logger.Warn("record oom kill", "app_id", app, "error", err)
		}
	}
	ended, err := lc.EndReplacedInstances(ctx, db.EndReplacedInstancesParams{
		AppID: app, Environment: env, InstanceID: instance, Now: at, PodUid: ident.PodUID, ContainerID: container,
	})
	if err != nil {
		e.logger.Warn("infer instance restarts", "app_id", app, "error", err)
		return
	}
	for _, r := range ended {
		if err := lc.RecordInstanceEnded(ctx, db.RecordInstanceEndedParams{
			ProjectID: r.ProjectID, AppID: app, Environment: env, InstanceID: r.InstanceID,
			ContainerID: r.ContainerID, PodName: r.PodName, Kind: r.EndedReason, At: at,
			ReplacedBy: instance, LastSeenAt: r.LastSeenAt,
		}); err != nil {
			e.logger.Warn("record instance end", "app_id", app, "instance_id", r.InstanceID, "error", err)
		}
	}
}
