package outbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"slices"
	"time"

	v1 "github.com/authzed/authzed-go/proto/authzed/api/v1"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/riverqueue/river"
	"google.golang.org/grpc"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/store/db"
)

// RelayInterval is how often the relay job runs when nothing wakes it
// earlier.
const RelayInterval = 2 * time.Second

// relayBatch is how many rows one relay transaction claims.
const relayBatch = 500

// relayLockKey is the advisory lock that serialises relay passes across
// processes, so rows reach SpiceDB strictly in id order.
const relayLockKey int64 = 0x6f7574626f78 // "outbox"

// relayMaxAttempts bounds retries of one relay job; the next periodic run
// picks up whatever it left behind anyway.
const relayMaxAttempts = 5

// SpiceDB is the part of the SpiceDB permissions API the relay writes
// through; *authzed.Client satisfies it.
type SpiceDB interface {
	WriteRelationships(ctx context.Context, in *v1.WriteRelationshipsRequest, opts ...grpc.CallOption) (*v1.WriteRelationshipsResponse, error)
	DeleteRelationships(ctx context.Context, in *v1.DeleteRelationshipsRequest, opts ...grpc.CallOption) (*v1.DeleteRelationshipsResponse, error)
	ReadRelationships(ctx context.Context, in *v1.ReadRelationshipsRequest, opts ...grpc.CallOption) (grpc.ServerStreamingClient[v1.ReadRelationshipsResponse], error)
}

// TokenRecorder stores the ZedToken of a write for an organization, so reads
// about it are at least as fresh; *authz.Client satisfies it.
type TokenRecorder interface {
	RecordToken(ctx context.Context, org, token string) error
}

// RelayOptions tunes a Relay.
type RelayOptions struct {
	// Timeout bounds each SpiceDB call. Default 5s.
	Timeout time.Duration
}

// Relay applies outbox rows to SpiceDB in id order (ADR 0006). Every topic
// translates to idempotent TOUCH/DELETE updates, so a row applied twice (a
// crash between the SpiceDB write and marking the row processed) leaves the
// same relationships as applying it once.
type Relay struct {
	pool    *pgxpool.Pool
	spicedb SpiceDB
	tokens  TokenRecorder
	timeout time.Duration
	logger  *slog.Logger
	wake    chan struct{}

	lag     prometheus.Gauge
	relayed *prometheus.CounterVec
	errors  prometheus.Counter
}

// NewRelay returns a Relay over pool. tokens, logger and reg may be nil.
func NewRelay(pool *pgxpool.Pool, spicedb SpiceDB, tokens TokenRecorder, opts RelayOptions, logger *slog.Logger, reg prometheus.Registerer) *Relay {
	if opts.Timeout <= 0 {
		opts.Timeout = 5 * time.Second
	}
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	r := &Relay{
		pool: pool, spicedb: spicedb, tokens: tokens, timeout: opts.Timeout, logger: logger,
		wake: make(chan struct{}, 1),
		lag: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "apilens_outbox_lag_seconds", Help: "Age of the oldest outbox row not yet applied to SpiceDB (0 when drained).",
		}),
		relayed: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "apilens_outbox_relayed_total", Help: "Outbox rows applied to SpiceDB, by topic.",
		}, []string{"topic"}),
		errors: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "apilens_outbox_relay_errors_total", Help: "Relay passes that stopped at a row they could not apply.",
		}),
	}
	if reg != nil {
		reg.MustRegister(r.lag, r.relayed, r.errors)
	}
	return r
}

// Drain applies pending rows until the outbox is empty or a row fails, and
// returns how many it applied. A failed row stops the pass (later rows must
// not overtake it); the rows before it stay applied and marked.
func (r *Relay) Drain(ctx context.Context) (int, error) {
	defer r.sampleLag(ctx)
	total := 0
	for {
		n, err := r.pass(ctx)
		total += n
		if err != nil {
			r.errors.Inc()
			return total, err
		}
		if n < relayBatch {
			return total, nil
		}
	}
}

// pass claims one batch in a transaction, applies and marks each row, and
// commits. On a failed row it commits the rows before it and returns the
// error.
func (r *Relay) pass(ctx context.Context) (int, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("outbox relay: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)
	if err := q.LockOutboxRelay(ctx, relayLockKey); err != nil {
		return 0, fmt.Errorf("outbox relay: lock: %w", err)
	}
	rows, err := q.ClaimPendingOutbox(ctx, relayBatch)
	if err != nil {
		return 0, fmt.Errorf("outbox relay: claim: %w", err)
	}
	applied := 0
	var applyErr error
	for _, row := range rows {
		if applyErr = r.apply(ctx, row); applyErr != nil {
			break
		}
		if err := q.MarkOutboxProcessed(ctx, row.ID); err != nil {
			return 0, fmt.Errorf("outbox relay: mark %d: %w", row.ID, err)
		}
		r.relayed.WithLabelValues(row.Topic).Inc()
		applied++
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("outbox relay: commit: %w", err)
	}
	return applied, applyErr
}

// apply writes one row's relationship changes and records the ZedToken for
// every organization the row touches.
func (r *Relay) apply(ctx context.Context, row db.ClaimPendingOutboxRow) error {
	c, err := Translate(Topic(row.Topic), row.Payload)
	if err != nil {
		return fmt.Errorf("outbox relay: row %d: %w", row.ID, err)
	}
	cctx, cancel := context.WithTimeout(ctx, r.timeout)
	defer cancel()
	orgs := c.Orgs
	if c.OrgsFrom != nil {
		found, err := r.subjectIDs(cctx, c.OrgsFrom)
		if err != nil {
			return fmt.Errorf("outbox relay: row %d (%s): read relationships: %w", row.ID, row.Topic, err)
		}
		orgs = append(orgs, found...)
	}
	var token string
	if c.Delete != nil {
		resp, err := r.spicedb.DeleteRelationships(cctx, &v1.DeleteRelationshipsRequest{RelationshipFilter: c.Delete})
		if err != nil {
			return fmt.Errorf("outbox relay: row %d (%s): delete relationships: %w", row.ID, row.Topic, err)
		}
		token = resp.GetDeletedAt().GetToken()
	}
	if len(c.Updates) > 0 {
		resp, err := r.spicedb.WriteRelationships(cctx, &v1.WriteRelationshipsRequest{Updates: c.Updates})
		if err != nil {
			return fmt.Errorf("outbox relay: row %d (%s): write relationships: %w", row.ID, row.Topic, err)
		}
		token = resp.GetWrittenAt().GetToken()
	}
	if r.tokens != nil {
		for _, org := range orgs {
			if err := r.tokens.RecordToken(ctx, org, token); err != nil {
				r.logger.WarnContext(ctx, "outbox relay: could not record zedtoken; reads may briefly be stale", "org", org, "error", err)
			}
		}
	}
	return nil
}

// subjectIDs returns the subject ids of every relationship matching filter.
func (r *Relay) subjectIDs(ctx context.Context, filter *v1.RelationshipFilter) ([]string, error) {
	stream, err := r.spicedb.ReadRelationships(ctx, &v1.ReadRelationshipsRequest{
		Consistency:        &v1.Consistency{Requirement: &v1.Consistency_FullyConsistent{FullyConsistent: true}},
		RelationshipFilter: filter,
	})
	if err != nil {
		return nil, err
	}
	var ids []string
	for {
		resp, err := stream.Recv()
		if errors.Is(err, io.EOF) {
			return ids, nil
		}
		if err != nil {
			return nil, err
		}
		ids = append(ids, resp.GetRelationship().GetSubject().GetObject().GetObjectId())
	}
}

func (r *Relay) sampleLag(ctx context.Context) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	lag, err := db.New(r.pool).OutboxLagSeconds(ctx)
	if err != nil {
		r.logger.WarnContext(ctx, "outbox relay: sample lag", "error", err)
		return
	}
	r.lag.Set(lag)
}

// Listen wakes the relay on every committed outbox row (Emit sends NOTIFY
// outbox) and drains it, so changes reach SpiceDB well within RelayInterval.
// It runs until ctx is cancelled; failed passes are logged and left to the
// periodic job, which retries with backoff.
func (r *Relay) Listen(ctx context.Context) error {
	go r.notifications(ctx)
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-r.wake:
		}
		if _, err := r.Drain(ctx); err != nil && ctx.Err() == nil {
			r.logger.WarnContext(ctx, "outbox relay: pass failed; the periodic job will retry", "error", err)
		}
	}
}

// notifications forwards NOTIFY outbox to r.wake, reconnecting with backoff
// when the listening connection fails. Wake-ups that arrive while a pass is
// running coalesce into one more pass.
func (r *Relay) notifications(ctx context.Context) {
	backoff := 100 * time.Millisecond
	for ctx.Err() == nil {
		err := r.listenOnce(ctx, func() { backoff = 100 * time.Millisecond })
		if ctx.Err() != nil {
			return
		}
		r.logger.WarnContext(ctx, "outbox relay: listen failed; retrying", "error", err, "in", backoff)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 10*time.Second)
	}
}

func (r *Relay) listenOnce(ctx context.Context, connected func()) error {
	conn, err := r.pool.Acquire(ctx)
	if err != nil {
		return err
	}
	// The connection carries a LISTEN: never hand it back to the pool.
	defer func() { _ = conn.Hijack().Close(context.WithoutCancel(ctx)) }()
	if _, err := conn.Exec(ctx, "LISTEN outbox"); err != nil {
		return err
	}
	connected()
	// Rows committed while nobody listened still need a pass.
	r.signal()
	for {
		if _, err := conn.Conn().WaitForNotification(ctx); err != nil {
			return err
		}
		r.signal()
	}
}

func (r *Relay) signal() {
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

// RelayArgs is the periodic relay job.
type RelayArgs struct{}

// Kind is the job kind.
func (RelayArgs) Kind() string { return "authz.outbox_relay" }

// InsertOpts caps retries: a later periodic run resumes where this one
// stopped.
func (RelayArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{MaxAttempts: relayMaxAttempts}
}

// RelayWorker works RelayArgs.
type RelayWorker struct {
	river.WorkerDefaults[RelayArgs]
	relay *Relay
}

// NewRelayWorker returns the worker for the periodic relay job.
func NewRelayWorker(relay *Relay) *RelayWorker { return &RelayWorker{relay: relay} }

// Work drains the outbox. An error makes River retry the job.
func (w *RelayWorker) Work(ctx context.Context, _ *river.Job[RelayArgs]) error {
	n, err := w.relay.Drain(ctx)
	if n > 0 {
		w.relay.logger.DebugContext(ctx, "outbox relay: applied rows", "rows", n)
	}
	return err
}

// NextRetry backs off exponentially from 1 s, capped at 30 s, instead of
// River's default of minutes to hours: authorization changes are expected
// within seconds.
func (w *RelayWorker) NextRetry(job *river.Job[RelayArgs]) time.Time {
	return time.Now().Add(RetryBackoff(job.Attempt))
}

// RetryBackoff is the wait before retry attempt (1-based) of a failed relay
// job.
func RetryBackoff(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	return min(time.Second<<min(attempt-1, 5), 30*time.Second)
}

// Change is the SpiceDB effect of one outbox row.
type Change struct {
	// Delete, when set, removes every relationship matching it, before
	// Updates are written.
	Delete *v1.RelationshipFilter
	// Updates are TOUCH/DELETE relationship updates, written atomically.
	Updates []*v1.RelationshipUpdate
	// Orgs are the organizations whose ZedToken the write updates.
	Orgs []string
	// OrgsFrom, when set, finds more such organizations before the write:
	// the subjects of the relationships it matches. A deleted project's
	// payload has no org id, so its org is read from SpiceDB (on a re-apply
	// it is already gone and reads fall back to SpiceDB's own freshness).
	OrgsFrom *v1.RelationshipFilter
}

// orgRoles are the organization relations a membership can hold.
var orgRoles = []string{"owner", "admin", "member", "viewer"}

// ErrUnknownTopic is returned (wrapped) by Translate for a topic this binary
// does not know. The row stays pending so a newer relay can apply it.
var ErrUnknownTopic = errors.New("outbox: unknown topic")

// Translate maps an outbox row to its SpiceDB change (the table in
// docs/architecture/identity.md).
func Translate(topic Topic, payload []byte) (Change, error) {
	switch topic {
	case OrgCreated:
		p, err := decode[OrgCreatedPayload](topic, payload)
		if err != nil {
			return Change{}, err
		}
		org := p.OrgID.String()
		return Change{
			Updates: []*v1.RelationshipUpdate{touch(orgRel(org, "owner", p.OwnerUserID))},
			Orgs:    []string{org},
		}, nil
	case OrgDeleted:
		p, err := decode[OrgDeletedPayload](topic, payload)
		if err != nil {
			return Change{}, err
		}
		org := p.OrgID.String()
		return Change{
			Delete: &v1.RelationshipFilter{ResourceType: authz.TypeOrganization, OptionalResourceId: org},
			Orgs:   []string{org},
		}, nil
	case MembershipUpserted:
		p, err := decode[MembershipUpsertedPayload](topic, payload)
		if err != nil {
			return Change{}, err
		}
		if !slices.Contains(orgRoles, p.Role) {
			return Change{}, fmt.Errorf("%w: %s has unknown role %q", ErrInvalid, topic, p.Role)
		}
		org := p.OrgID.String()
		updates := make([]*v1.RelationshipUpdate, 0, len(orgRoles))
		for _, role := range orgRoles {
			if role != p.Role {
				updates = append(updates, del(orgRel(org, role, p.UserID)))
			}
		}
		updates = append(updates, touch(orgRel(org, p.Role, p.UserID)))
		return Change{Updates: updates, Orgs: []string{org}}, nil
	case MembershipDeleted:
		p, err := decode[MembershipDeletedPayload](topic, payload)
		if err != nil {
			return Change{}, err
		}
		org := p.OrgID.String()
		updates := make([]*v1.RelationshipUpdate, 0, len(orgRoles))
		for _, role := range orgRoles {
			updates = append(updates, del(orgRel(org, role, p.UserID)))
		}
		return Change{Updates: updates, Orgs: []string{org}}, nil
	case ProjectCreated:
		p, err := decode[ProjectCreatedPayload](topic, payload)
		if err != nil {
			return Change{}, err
		}
		updates := []*v1.RelationshipUpdate{touch(projectOrg(p.ProjectID, p.OrgID))}
		for _, r := range orgRoleDefaults(p.ProjectID, p.OrgID) {
			updates = append(updates, touch(r))
		}
		return Change{Updates: updates, Orgs: []string{p.OrgID.String()}}, nil
	case ProjectDeleted:
		p, err := decode[ProjectDeletedPayload](topic, payload)
		if err != nil {
			return Change{}, err
		}
		project := p.ProjectID.String()
		return Change{
			Delete:   &v1.RelationshipFilter{ResourceType: authz.TypeProject, OptionalResourceId: project},
			OrgsFrom: &v1.RelationshipFilter{ResourceType: authz.TypeProject, OptionalResourceId: project, OptionalRelation: "org"},
		}, nil
	case ProjectMoved:
		p, err := decode[ProjectMovedPayload](topic, payload)
		if err != nil {
			return Change{}, err
		}
		if p.FromOrgID == p.ToOrgID {
			return Change{Updates: []*v1.RelationshipUpdate{touch(projectOrg(p.ProjectID, p.ToOrgID))}, Orgs: []string{p.ToOrgID.String()}}, nil
		}
		updates := []*v1.RelationshipUpdate{del(projectOrg(p.ProjectID, p.FromOrgID)), touch(projectOrg(p.ProjectID, p.ToOrgID))}
		for _, r := range orgRoleDefaults(p.ProjectID, p.FromOrgID) {
			updates = append(updates, del(r))
		}
		for _, r := range orgRoleDefaults(p.ProjectID, p.ToOrgID) {
			updates = append(updates, touch(r))
		}
		return Change{Updates: updates, Orgs: []string{p.FromOrgID.String(), p.ToOrgID.String()}}, nil
	default:
		return Change{}, fmt.Errorf("%w: %q", ErrUnknownTopic, topic)
	}
}

func decode[P any](topic Topic, payload []byte) (P, error) {
	var p P
	if err := json.Unmarshal(payload, &p); err != nil {
		return p, fmt.Errorf("%w: %s payload: %w", ErrInvalid, topic, err)
	}
	return p, nil
}

func orgRel(org, role string, user uuid.UUID) *v1.Relationship {
	return &v1.Relationship{
		Resource: &v1.ObjectReference{ObjectType: authz.TypeOrganization, ObjectId: org},
		Relation: role,
		Subject:  &v1.SubjectReference{Object: &v1.ObjectReference{ObjectType: authz.TypeUser, ObjectId: user.String()}},
	}
}

func projectOrg(project, org uuid.UUID) *v1.Relationship {
	return &v1.Relationship{
		Resource: &v1.ObjectReference{ObjectType: authz.TypeProject, ObjectId: project.String()},
		Relation: "org",
		Subject:  &v1.SubjectReference{Object: &v1.ObjectReference{ObjectType: authz.TypeOrganization, ObjectId: org.String()}},
	}
}

// orgRoleDefaults are the default-access relations for `org_role` (ADR 0009):
// org members edit the project, org viewers view it. Every project has this
// default until per-project default access is stored (#766, #767).
func orgRoleDefaults(project, org uuid.UUID) []*v1.Relationship {
	set := func(relation, orgRole string) *v1.Relationship {
		return &v1.Relationship{
			Resource: &v1.ObjectReference{ObjectType: authz.TypeProject, ObjectId: project.String()},
			Relation: relation,
			Subject: &v1.SubjectReference{
				Object:           &v1.ObjectReference{ObjectType: authz.TypeOrganization, ObjectId: org.String()},
				OptionalRelation: orgRole,
			},
		}
	}
	return []*v1.Relationship{set("default_editor", "member"), set("default_viewer", "viewer")}
}

func touch(r *v1.Relationship) *v1.RelationshipUpdate {
	return &v1.RelationshipUpdate{Operation: v1.RelationshipUpdate_OPERATION_TOUCH, Relationship: r}
}

func del(r *v1.Relationship) *v1.RelationshipUpdate {
	return &v1.RelationshipUpdate{Operation: v1.RelationshipUpdate_OPERATION_DELETE, Relationship: r}
}
