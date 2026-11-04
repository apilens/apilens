package outbox

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"slices"
	"time"

	v1 "github.com/authzed/authzed-go/proto/authzed/api/v1"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/riverqueue/river"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/store/db"
)

// ReconcileInterval is how often the reconciler job runs (ADR 0006).
const ReconcileInterval = time.Hour

// reconcileWriteBatch is how many updates one WriteRelationships call
// carries; SpiceDB refuses more than 1000 by default.
const reconcileWriteBatch = 500

// reconcileMaxAttempts bounds retries of one reconcile job; the next hourly
// run repairs whatever it left behind anyway.
const reconcileMaxAttempts = 3

// ReconcileOptions tunes a Reconciler.
type ReconcileOptions struct {
	// Timeout bounds each SpiceDB call (a full read of one resource type
	// is one call). Default 1m.
	Timeout time.Duration
}

// ReconcileResult reports one reconcile run.
type ReconcileResult struct {
	// Missing counts relationships Postgres implies but SpiceDB lacked
	// (restored with TOUCH, unless DryRun).
	Missing int `json:"missing"`
	// Extra counts relationships SpiceDB held that Postgres does not imply
	// (removed with DELETE, unless DryRun).
	Extra int `json:"extra"`
	// DryRun is true when the drift was only counted, not repaired.
	DryRun bool `json:"dry_run"`
}

// Reconciler repairs drift between Postgres (the source of truth) and
// SpiceDB (ADR 0006): relationships lost or left behind by a manual edit, a
// restored backup or a bug in the relay.
//
// It owns the relationships the relay writes: organization#{owner,admin,
// member,viewer}@user and project#org@organization. Postgres implies one org
// role per membership of an active organization and one project#org per
// active project of an active organization. Relationships SpiceDB holds that
// Postgres has no source for yet (project-level roles) are left alone.
//
// A run holds the relay's advisory lock while it reads Postgres and SpiceDB
// and writes the repair, so the relay cannot apply a row in between and have
// it undone by a stale snapshot. Changes committed during the run leave
// outbox rows the relay applies after it, in order, on top of the repair.
type Reconciler struct {
	pool    *pgxpool.Pool
	spicedb SpiceDB
	tokens  TokenRecorder
	timeout time.Duration
	logger  *slog.Logger
	drift   *prometheus.CounterVec
}

// NewReconciler returns a Reconciler over pool. tokens, logger and reg may be
// nil.
func NewReconciler(pool *pgxpool.Pool, spicedb SpiceDB, tokens TokenRecorder, opts ReconcileOptions, logger *slog.Logger, reg prometheus.Registerer) *Reconciler {
	if opts.Timeout <= 0 {
		opts.Timeout = time.Minute
	}
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	r := &Reconciler{
		pool: pool, spicedb: spicedb, tokens: tokens, timeout: opts.Timeout, logger: logger,
		drift: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "apilens_authz_drift_total",
			Help: "Relationships the reconciler found out of sync between Postgres and SpiceDB and repaired, by kind (missing, extra).",
		}, []string{"kind"}),
	}
	if reg != nil {
		reg.MustRegister(r.drift)
	}
	return r
}

// Reconcile compares Postgres with SpiceDB and, unless dryRun, writes the
// TOUCH/DELETE updates that make SpiceDB match.
func (r *Reconciler) Reconcile(ctx context.Context, dryRun bool) (ReconcileResult, error) {
	res := ReconcileResult{DryRun: dryRun}
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return res, fmt.Errorf("authz reconcile: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	// Each statement below reads a snapshot taken after the lock (READ
	// COMMITTED), so everything the relay applied before is visible.
	if err := q.LockOutboxRelay(ctx, relayLockKey); err != nil {
		return res, fmt.Errorf("authz reconcile: lock: %w", err)
	}
	want, err := r.desired(ctx, q)
	if err != nil {
		return res, err
	}
	have, err := r.actual(ctx)
	if err != nil {
		return res, err
	}

	var updates []*v1.RelationshipUpdate
	for _, k := range sortedKeys(want) {
		if _, ok := have[k]; !ok {
			updates = append(updates, touch(want[k]))
			res.Missing++
		}
	}
	for _, k := range sortedKeys(have) {
		if _, ok := want[k]; !ok {
			updates = append(updates, del(have[k]))
			res.Extra++
		}
	}
	if len(updates) == 0 {
		r.logger.DebugContext(ctx, "authz reconcile: no drift", "relationships", len(want))
		return res, nil
	}
	r.logger.WarnContext(ctx, "authz reconcile: drift between Postgres and SpiceDB",
		"missing", res.Missing, "extra", res.Extra, "dry_run", dryRun)
	if dryRun {
		return res, nil
	}
	if err := r.write(ctx, updates); err != nil {
		return res, err
	}
	r.drift.WithLabelValues("missing").Add(float64(res.Missing))
	r.drift.WithLabelValues("extra").Add(float64(res.Extra))
	if err := tx.Commit(ctx); err != nil {
		return res, fmt.Errorf("authz reconcile: commit: %w", err)
	}
	return res, nil
}

// desired returns the relationships Postgres implies, keyed by relKey.
func (r *Reconciler) desired(ctx context.Context, q *db.Queries) (map[string]*v1.Relationship, error) {
	members, err := q.ListReconcileMemberships(ctx)
	if err != nil {
		return nil, fmt.Errorf("authz reconcile: list memberships: %w", err)
	}
	projects, err := q.ListReconcileProjects(ctx)
	if err != nil {
		return nil, fmt.Errorf("authz reconcile: list projects: %w", err)
	}
	want := make(map[string]*v1.Relationship, len(members)+len(projects))
	for _, m := range members {
		rel := orgRel(m.OrgID.String(), m.Role, m.UserID)
		want[relKey(rel)] = rel
	}
	for _, p := range projects {
		rel := projectOrg(p.ID, p.OrgID)
		want[relKey(rel)] = rel
	}
	return want, nil
}

// actual returns the relationships SpiceDB holds that the reconciler owns,
// keyed by relKey.
func (r *Reconciler) actual(ctx context.Context) (map[string]*v1.Relationship, error) {
	have := map[string]*v1.Relationship{}
	for _, f := range []struct {
		filter *v1.RelationshipFilter
		owned  func(*v1.Relationship) bool
	}{
		{&v1.RelationshipFilter{ResourceType: authz.TypeOrganization}, func(rel *v1.Relationship) bool {
			return slices.Contains(orgRoles, rel.GetRelation()) && rel.GetSubject().GetObject().GetObjectType() == authz.TypeUser
		}},
		{&v1.RelationshipFilter{ResourceType: authz.TypeProject, OptionalRelation: "org"}, func(rel *v1.Relationship) bool {
			return rel.GetSubject().GetObject().GetObjectType() == authz.TypeOrganization
		}},
	} {
		rels, err := r.read(ctx, f.filter)
		if err != nil {
			return nil, fmt.Errorf("authz reconcile: read %s relationships: %w", f.filter.GetResourceType(), err)
		}
		for _, rel := range rels {
			if f.owned(rel) {
				have[relKey(rel)] = rel
			}
		}
	}
	return have, nil
}

// read streams every relationship matching filter, fully consistent.
func (r *Reconciler) read(ctx context.Context, filter *v1.RelationshipFilter) ([]*v1.Relationship, error) {
	ctx, cancel := context.WithTimeout(ctx, r.timeout)
	defer cancel()
	stream, err := r.spicedb.ReadRelationships(ctx, &v1.ReadRelationshipsRequest{
		Consistency:        &v1.Consistency{Requirement: &v1.Consistency_FullyConsistent{FullyConsistent: true}},
		RelationshipFilter: filter,
	})
	if err != nil {
		return nil, err
	}
	var rels []*v1.Relationship
	for {
		resp, err := stream.Recv()
		if errors.Is(err, io.EOF) {
			return rels, nil
		}
		if err != nil {
			return nil, err
		}
		rels = append(rels, resp.GetRelationship())
	}
}

// write applies updates in batches and records the ZedToken for every
// organization they touch.
func (r *Reconciler) write(ctx context.Context, updates []*v1.RelationshipUpdate) error {
	for batch := range slices.Chunk(updates, reconcileWriteBatch) {
		cctx, cancel := context.WithTimeout(ctx, r.timeout)
		resp, err := r.spicedb.WriteRelationships(cctx, &v1.WriteRelationshipsRequest{Updates: batch})
		cancel()
		if err != nil {
			return fmt.Errorf("authz reconcile: write relationships: %w", err)
		}
		if r.tokens == nil {
			continue
		}
		token := resp.GetWrittenAt().GetToken()
		seen := map[string]bool{}
		for _, u := range batch {
			org := relOrg(u.GetRelationship())
			if seen[org] {
				continue
			}
			seen[org] = true
			if err := r.tokens.RecordToken(ctx, org, token); err != nil {
				r.logger.WarnContext(ctx, "authz reconcile: could not record zedtoken; reads may briefly be stale", "org", org, "error", err)
			}
		}
	}
	return nil
}

// relOrg is the organization whose reads a relationship affects.
func relOrg(rel *v1.Relationship) string {
	if rel.GetResource().GetObjectType() == authz.TypeOrganization {
		return rel.GetResource().GetObjectId()
	}
	return rel.GetSubject().GetObject().GetObjectId()
}

// relKey renders a relationship as "type:id#relation@type:id[#relation]".
func relKey(rel *v1.Relationship) string {
	s := rel.GetSubject()
	k := rel.GetResource().GetObjectType() + ":" + rel.GetResource().GetObjectId() + "#" + rel.GetRelation() +
		"@" + s.GetObject().GetObjectType() + ":" + s.GetObject().GetObjectId()
	if s.GetOptionalRelation() != "" {
		k += "#" + s.GetOptionalRelation()
	}
	return k
}

func sortedKeys(m map[string]*v1.Relationship) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}

// ReconcileArgs is the hourly reconcile job.
type ReconcileArgs struct{}

// Kind is the job kind.
func (ReconcileArgs) Kind() string { return "authz.reconcile" }

// InsertOpts caps retries: the next hourly run repairs what this one could
// not.
func (ReconcileArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{MaxAttempts: reconcileMaxAttempts}
}

// ReconcileWorker works ReconcileArgs.
type ReconcileWorker struct {
	river.WorkerDefaults[ReconcileArgs]
	reconciler *Reconciler
}

// NewReconcileWorker returns the worker for the hourly reconcile job.
func NewReconcileWorker(reconciler *Reconciler) *ReconcileWorker {
	return &ReconcileWorker{reconciler: reconciler}
}

// Work reconciles once. An error makes River retry the job.
func (w *ReconcileWorker) Work(ctx context.Context, _ *river.Job[ReconcileArgs]) error {
	_, err := w.reconciler.Reconcile(ctx, false)
	return err
}

// Timeout lets a run over a large installation outlast River's default of
// one minute.
func (w *ReconcileWorker) Timeout(*river.Job[ReconcileArgs]) time.Duration {
	return 15 * time.Minute
}
