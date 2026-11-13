package purge

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/valkey-io/valkey-go"

	"github.com/apilens/apilens/internal/controlplane/outbox"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/identity/audit"
)

// How a project is purged.
//
// A project is due when it was deleted and its purge_after has passed (or
// it was deleted before purge_after existed), or when its organization was
// deleted more than the deletion grace ago: an organization delete cannot
// be undone, so its projects follow it through the same job and the same
// grace as a project delete.
//
// The purge runs these steps in order, each idempotent; project_purges
// records the next one, so a run that is killed half-way resumes there:
//
//  1. clickhouse: delete the rows of project_id from every table in
//     ClickHouseTables (a mutation, waited for).
//  2. valkey: delete every apilens:* key naming the project, one of its
//     apps or one of its API keys (usage, quota, stats, last seen, ...).
//  3. files: remove the stored files of its request exports.
//  4. postgres, one transaction: hard-delete apps, environments, keys,
//     policies, alert rules and channels, health checks, uptime monitors,
//     saved views, exports, direct grants and invitation grants; emit
//     project.deleted again (the relay drops any SpiceDB relationship of
//     the project); move the slug to the 30-day reservation; leave the
//     projects row as a tombstone (id, org, slug, name) for the audit log
//     and the reservation; audit project.purged (org-scoped, no actor); mark
//     the purge done.
//
// Audit events of the project are kept: they carry project_id and the
// target label, which stay readable after the purge.

const (
	stepClickHouse = "clickhouse"
	stepValkey     = "valkey"
	stepFiles      = "files"
	stepPostgres   = "postgres"
	stepDone       = "done"
)

// steps lists the steps in the order they run.
var steps = []string{stepClickHouse, stepValkey, stepFiles, stepPostgres, stepDone}

// Interval is how often the purge job runs.
const Interval = time.Hour

// batch is how many due projects one job run purges.
const batch = 100

// jobTimeout bounds one job run: ClickHouse mutations over large tables take
// a while.
const jobTimeout = 30 * time.Minute

// valkeyPrefix is the prefix of every Valkey key APILens writes.
const valkeyPrefix = "apilens:"

var (
	// ErrNotFound: no project has this id.
	ErrNotFound = errors.New("purge: project not found")
	// ErrNotDeleted: the project and its organization are active.
	ErrNotDeleted = errors.New("purge: project is not deleted")
)

// Pool is the Postgres access the purge needs; *pgxpool.Pool satisfies it.
type Pool interface {
	db.DBTX
	Begin(ctx context.Context) (pgx.Tx, error)
}

// ClickHouse runs a statement; clickhouse-go's driver.Conn satisfies it.
type ClickHouse interface {
	Exec(ctx context.Context, query string, args ...any) error
}

// FileRemover removes a stored export file; a missing file is not an error.
// query.ExportStore satisfies it.
type FileRemover interface {
	Remove(ctx context.Context, key string) error
}

// Auditor records audit events; *audit.Recorder satisfies it.
type Auditor interface {
	Record(ctx context.Context, e audit.Event) error
}

// Purger removes deleted projects' data.
type Purger struct {
	pool   Pool
	ch     ClickHouse
	valkey valkey.Client
	files  FileRemover
	audit  Auditor
	grace  time.Duration
	logger *slog.Logger
}

// Options are the Purger's optional parts.
type Options struct {
	// Valkey is where the ingest counters live; nil when Valkey is disabled.
	Valkey valkey.Client
	// Files stores request export files; nil skips the files step.
	Files FileRemover
	// Audit records project.purged; nil records nothing.
	Audit Auditor
	// OrgGrace is how long after an organization delete its projects are
	// purged (project.deletion_grace).
	OrgGrace time.Duration
}

// New returns a Purger over pool and ch.
func New(pool Pool, ch ClickHouse, opts Options, logger *slog.Logger) *Purger {
	if logger == nil {
		logger = slog.Default()
	}
	return &Purger{
		pool: pool, ch: ch, valkey: opts.Valkey, files: opts.Files, audit: opts.Audit,
		grace: max(opts.OrgGrace, 0), logger: logger,
	}
}

// PurgeDue purges every project that is due, up to batch of them, and
// returns how many it finished. A project that fails is left where it
// stopped for the next run; the others still run.
func (p *Purger) PurgeDue(ctx context.Context) (int, error) {
	ids, err := db.New(p.pool).ListPurgeDueProjects(ctx, db.ListPurgeDueProjectsParams{
		OrgGraceSeconds: int64(p.grace / time.Second), MaxProjects: batch,
	})
	if err != nil {
		return 0, fmt.Errorf("purge: list due projects: %w", err)
	}
	var done int
	var errs []error
	for _, id := range ids {
		if err := p.Purge(ctx, id); err != nil {
			errs = append(errs, err)
			continue
		}
		done++
	}
	return done, errors.Join(errs...)
}

// Purge removes the data of the deleted project id now, whether or not its
// grace period has passed (the operator command); the job only passes
// projects that are due. ErrNotFound when there is no such project,
// ErrNotDeleted when it and its organization are active. Purging a project
// that is already purged does nothing.
func (p *Purger) Purge(ctx context.Context, id uuid.UUID) error {
	q := db.New(p.pool)
	cand, err := q.GetPurgeCandidate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("purge: get project: %w", err)
	}
	if cand.Step == stepDone {
		return nil
	}
	if cand.DeletedAt == nil && cand.OrgDeletedAt == nil {
		return ErrNotDeleted
	}
	if err := q.EndProjectGrace(ctx, id); err != nil {
		return fmt.Errorf("purge: end grace period: %w", err)
	}
	step, err := q.StartProjectPurge(ctx, id)
	if err != nil {
		return fmt.Errorf("purge: start: %w", err)
	}
	for step != stepDone {
		if err := p.run(ctx, id, step); err != nil {
			msg := err.Error()
			if ferr := q.FailProjectPurge(context.WithoutCancel(ctx), db.FailProjectPurgeParams{ProjectID: id, Error: &msg}); ferr != nil {
				err = errors.Join(err, ferr)
			}
			return fmt.Errorf("purge: project %s: step %s: %w", id, step, err)
		}
		next := nextStep(step)
		if step != stepPostgres { // the postgres step marks the purge done itself
			if err := q.SetProjectPurgeStep(ctx, db.SetProjectPurgeStepParams{ProjectID: id, Step: next}); err != nil {
				return fmt.Errorf("purge: project %s: record step %s: %w", id, next, err)
			}
		}
		step = next
	}
	p.logger.InfoContext(ctx, "purge: project purged", "project_id", id)
	return nil
}

func nextStep(step string) string {
	for i, s := range steps[:len(steps)-1] {
		if s == step {
			return steps[i+1]
		}
	}
	return stepDone
}

func (p *Purger) run(ctx context.Context, id uuid.UUID, step string) error {
	switch step {
	case stepClickHouse:
		return p.purgeClickHouse(ctx, id)
	case stepValkey:
		return p.purgeValkey(ctx, id)
	case stepFiles:
		return p.purgeFiles(ctx, id)
	case stepPostgres:
		return p.purgePostgres(ctx, id)
	default:
		return fmt.Errorf("unknown step %q", step)
	}
}

// purgeClickHouse deletes the project's rows from every telemetry table and
// waits for the mutations to finish.
func (p *Purger) purgeClickHouse(ctx context.Context, id uuid.UUID) error {
	ctx = clickhouse.Context(ctx, clickhouse.WithSettings(clickhouse.Settings{"mutations_sync": 2}))
	for _, t := range ClickHouseTables {
		if err := p.ch.Exec(ctx, DeleteStatement(t), id); err != nil {
			return fmt.Errorf("clickhouse %s: %w", t, err)
		}
	}
	return nil
}

// DeleteStatement is the statement that deletes a project's rows from the
// ClickHouse table (its one argument is the project id).
func DeleteStatement(table string) string {
	return "ALTER TABLE " + table + " DELETE WHERE project_id = ?"
}

// purgeValkey deletes every APILens key that names the project, one of its
// apps or one of its API keys. Keys are scanned on every node, so this works
// in cluster mode too.
func (p *Purger) purgeValkey(ctx context.Context, id uuid.UUID) error {
	if p.valkey == nil {
		return nil
	}
	q := db.New(p.pool)
	apps, err := q.ListPurgeAppIDs(ctx, id)
	if err != nil {
		return fmt.Errorf("list apps: %w", err)
	}
	keys, err := q.ListPurgeKeyIDs(ctx, id)
	if err != nil {
		return fmt.Errorf("list api keys: %w", err)
	}
	ids := make([]string, 0, 1+len(apps)+len(keys))
	ids = append(ids, id.String())
	for _, a := range apps {
		ids = append(ids, a.String())
	}
	for _, k := range keys {
		ids = append(ids, k.String())
	}
	for _, node := range p.valkey.Nodes() {
		var cursor uint64
		for {
			entry, err := node.Do(ctx, node.B().Scan().Cursor(cursor).Match(valkeyPrefix+"*").Count(1000).Build()).AsScanEntry()
			if err != nil {
				return fmt.Errorf("valkey scan: %w", err)
			}
			var cmds valkey.Commands
			for _, k := range entry.Elements {
				if NamesAny(k, ids) {
					cmds = append(cmds, p.valkey.B().Unlink().Key(k).Build())
				}
			}
			for _, r := range p.valkey.DoMulti(ctx, cmds...) {
				if err := r.Error(); err != nil {
					return fmt.Errorf("valkey unlink: %w", err)
				}
			}
			cursor = entry.Cursor
			if cursor == 0 {
				break
			}
		}
	}
	return nil
}

// NamesAny reports whether the Valkey key contains one of the ids.
func NamesAny(key string, ids []string) bool {
	for _, id := range ids {
		if strings.Contains(key, id) {
			return true
		}
	}
	return false
}

// purgeFiles removes the stored files of the project's request exports.
func (p *Purger) purgeFiles(ctx context.Context, id uuid.UUID) error {
	if p.files == nil {
		return nil
	}
	keys, err := db.New(p.pool).ListPurgeExportFiles(ctx, id)
	if err != nil {
		return fmt.Errorf("list export files: %w", err)
	}
	for _, k := range keys {
		if err := p.files.Remove(ctx, k); err != nil {
			return fmt.Errorf("remove export file: %w", err)
		}
	}
	return nil
}

// postgresDeletes are the hard deletes of the postgres step, children
// before the rows they reference.
var postgresDeletes = []struct {
	table string
	run   func(*db.Queries, context.Context, uuid.UUID) (int64, error)
}{
	{"alert_events", (*db.Queries).PurgeProjectAlertEvents},
	{"alert_rules", (*db.Queries).PurgeProjectAlertRules},
	{"notification_channels", (*db.Queries).PurgeProjectNotificationChannels},
	{"health_checks", (*db.Queries).PurgeProjectHealthChecks},
	{"uptime_monitors", (*db.Queries).PurgeProjectUptimeMonitors},
	{"privacy_policies", (*db.Queries).PurgeProjectPrivacyPolicies},
	{"capture_policies", (*db.Queries).PurgeProjectCapturePolicies},
	{"endpoint_settings", (*db.Queries).PurgeProjectEndpointSettings},
	{"app_metadata", (*db.Queries).PurgeProjectAppMetadata},
	{"app_instances", (*db.Queries).PurgeProjectAppInstances},
	{"app_aliases", (*db.Queries).PurgeProjectAppAliases},
	{"saved_views", (*db.Queries).PurgeProjectSavedViews},
	{"request_exports", (*db.Queries).PurgeProjectRequestExports},
	{"project_members", (*db.Queries).PurgeProjectMembers},
	{"invitation_project_grants", (*db.Queries).PurgeProjectInvitationGrants},
	{"apps", (*db.Queries).PurgeProjectApps},
	{"api_keys", (*db.Queries).PurgeProjectAPIKeys},
	{"environments", (*db.Queries).PurgeProjectEnvironments},
}

// purgePostgres is the last step, one transaction: the project's rows go,
// its SpiceDB relationships are dropped through the outbox, its slug moves
// to the reservation, project.purged is recorded and the purge is marked
// done.
func (p *Purger) purgePostgres(ctx context.Context, id uuid.UUID) error {
	tx, err := p.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	cur, err := q.LockPurgingProject(ctx, id)
	if err != nil {
		return fmt.Errorf("lock project: %w", err)
	}
	if cur.Step == stepDone {
		return nil
	}
	rows := map[string]int64{}
	for _, d := range postgresDeletes {
		n, err := d.run(q, ctx, id)
		if err != nil {
			return fmt.Errorf("delete %s: %w", d.table, err)
		}
		if n > 0 {
			rows[d.table] = n
		}
	}
	if err := outbox.Emit(ctx, tx, outbox.ProjectDeleted, id, outbox.ProjectDeletedPayload{ProjectID: id}); err != nil {
		return err
	}
	if err := q.ReservePurgedProjectSlug(ctx, db.ReservePurgedProjectSlugParams{Slug: cur.Slug, ProjectID: id}); err != nil {
		return fmt.Errorf("reserve slug: %w", err)
	}
	if err := q.TombstonePurgedProject(ctx, id); err != nil {
		return fmt.Errorf("tombstone: %w", err)
	}
	if p.audit != nil {
		if err := p.audit.Record(audit.WithTx(ctx, tx), audit.Event{
			Kind:   audit.ProjectPurged,
			Org:    &cur.OrgID,
			Target: audit.Target{Type: "project", ID: id.String(), Label: cur.Name},
			Meta:   map[string]any{"project_id": id.String(), "slug": cur.Slug, "rows": rows},
		}); err != nil {
			return err
		}
	}
	if err := q.FinishProjectPurge(ctx, id); err != nil {
		return fmt.Errorf("finish: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

// Args is the periodic job that purges deleted projects whose grace period
// has passed.
type Args struct{}

// Kind is the job kind.
func (Args) Kind() string { return "controlplane.purge_deleted_projects" }

// Worker works Args.
type Worker struct {
	river.WorkerDefaults[Args]
	purger *Purger
	logger *slog.Logger
}

// NewWorker returns the purge worker.
func NewWorker(purger *Purger, logger *slog.Logger) *Worker {
	return &Worker{purger: purger, logger: logger}
}

// Timeout leaves room for the ClickHouse mutations.
func (*Worker) Timeout(*river.Job[Args]) time.Duration { return jobTimeout }

// Work purges the projects that are due.
func (w *Worker) Work(ctx context.Context, _ *river.Job[Args]) error {
	n, err := w.purger.PurgeDue(ctx)
	if n > 0 {
		w.logger.InfoContext(ctx, "purge: purged deleted projects", "projects", n)
	}
	return err
}
