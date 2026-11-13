//go:build integration

package outbox_test

import (
	"context"
	"errors"
	"testing"
	"time"

	v1 "github.com/authzed/authzed-go/proto/authzed/api/v1"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus"
	"google.golang.org/grpc"

	schema "github.com/apilens/apilens/authz"
	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/outbox"
	"github.com/apilens/apilens/internal/platform/cache"
	"github.com/apilens/apilens/internal/platform/spicedb"
	tu "github.com/apilens/apilens/internal/testutil"
)

type relayEnv struct {
	pool   *pgxpool.Pool
	sdb    outbox.SpiceDB
	authz  *authz.Client
	tokens authz.TokenStore
}

func newRelayEnv(t *testing.T) relayEnv {
	t.Helper()
	ctx := context.Background()
	pool := tu.MigratedPostgres(t)
	sdb, err := spicedb.Connect(tu.SpiceDB(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sdb.Close() })
	if err := spicedb.ApplySchema(ctx, sdb, schema.Schema, tu.Logger(t)); err != nil {
		t.Fatal(err)
	}
	vk, err := cache.Connect(ctx, tu.Valkey(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(vk.Close)
	tokens := authz.NewValkeyTokens(vk)
	return relayEnv{pool: pool, sdb: sdb, tokens: tokens, authz: authz.New(sdb, tokens, authz.Options{}, tu.Logger(t), nil)}
}

func emit(t *testing.T, pool *pgxpool.Pool, topic outbox.Topic, agg uuid.UUID, p outbox.Payload) {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := outbox.Emit(ctx, tx, topic, agg, p); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
}

// eventually polls cond until it holds or within elapses.
func eventually(t *testing.T, within time.Duration, what string, cond func() bool) {
	t.Helper()
	start := time.Now()
	for !cond() {
		if time.Since(start) > within {
			t.Fatalf("%s: not true within %v", what, within)
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Logf("%s after %v", what, time.Since(start).Round(time.Millisecond))
}

func pending(t *testing.T, pool *pgxpool.Pool) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM outbox WHERE processed_at IS NULL`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestRelayAppliesMembershipChangesWithinASecond(t *testing.T) {
	env := newRelayEnv(t)
	reg := prometheus.NewRegistry()
	relay := outbox.NewRelay(env.pool, env.sdb, env.authz, outbox.RelayOptions{}, tu.Logger(t), reg)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- relay.Listen(ctx) }()
	t.Cleanup(func() {
		cancel()
		if err := <-done; err != nil {
			t.Error(err)
		}
	})

	org, owner, user, proj := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	emit(t, env.pool, outbox.OrgCreated, org, outbox.OrgCreatedPayload{OrgID: org, OwnerUserID: owner})
	emit(t, env.pool, outbox.ProjectCreated, proj, outbox.ProjectCreatedPayload{ProjectID: proj, OrgID: org})

	check := func(u uuid.UUID, perm authz.Permission, res authz.Resource) bool {
		ok, err := env.authz.Check(context.Background(), authz.User(u.String()), perm, res)
		if err != nil {
			t.Fatal(err)
		}
		return ok
	}
	project := authz.Project(org.String(), proj.String())

	// Membership create: the NOTIFY-driven relay makes it visible within 1 s.
	emit(t, env.pool, outbox.MembershipUpserted, org, outbox.MembershipUpsertedPayload{OrgID: org, UserID: user, Role: "member"})
	eventually(t, time.Second, "member can edit the project", func() bool { return check(user, authz.ProjectEdit, project) })
	if !check(owner, authz.ProjectDelete, project) {
		t.Fatal("owner cannot delete the project")
	}
	if tok, _ := env.tokens.Get(context.Background(), org.String()); tok == "" {
		t.Fatal("relay stored no zedtoken for the org")
	}

	// Role change replaces the old role.
	emit(t, env.pool, outbox.MembershipUpserted, org, outbox.MembershipUpsertedPayload{OrgID: org, UserID: user, Role: "viewer"})
	eventually(t, time.Second, "viewer can no longer edit", func() bool { return !check(user, authz.ProjectEdit, project) })
	if !check(user, authz.ProjectView, project) {
		t.Fatal("viewer cannot view the project")
	}

	// Membership delete.
	emit(t, env.pool, outbox.MembershipDeleted, org, outbox.MembershipDeletedPayload{OrgID: org, UserID: user})
	eventually(t, time.Second, "removed member cannot view", func() bool { return !check(user, authz.ProjectView, project) })

	// Project and org deletion remove every relationship.
	emit(t, env.pool, outbox.ProjectDeleted, proj, outbox.ProjectDeletedPayload{ProjectID: proj})
	eventually(t, time.Second, "deleted project is invisible to the owner", func() bool { return !check(owner, authz.ProjectView, project) })
	emit(t, env.pool, outbox.OrgDeleted, org, outbox.OrgDeletedPayload{OrgID: org})
	eventually(t, time.Second, "deleted org is invisible to the owner", func() bool { return !check(owner, authz.OrgView, authz.Organization(org.String())) })

	eventually(t, time.Second, "outbox drained", func() bool { return pending(t, env.pool) == 0 })
	eventually(t, time.Second, "lag is 0", func() bool { return gauge(t, reg, "apilens_outbox_lag_seconds") == 0 })
}

func TestRelayAppliesProjectRolesAndDefaultAccess(t *testing.T) {
	env := newRelayEnv(t)
	ctx := context.Background()
	relay := outbox.NewRelay(env.pool, env.sdb, env.authz, outbox.RelayOptions{}, tu.Logger(t), nil)
	drain := func() {
		t.Helper()
		if _, err := relay.Drain(ctx); err != nil {
			t.Fatal(err)
		}
	}
	check := func(u uuid.UUID, perm authz.Permission, res authz.Resource) bool {
		t.Helper()
		ok, err := env.authz.Check(ctx, authz.User(u.String()), perm, res)
		if err != nil {
			t.Fatal(err)
		}
		return ok
	}

	org, owner, member, viewer, guest, proj := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	project := authz.Project(org.String(), proj.String())
	emit(t, env.pool, outbox.OrgCreated, org, outbox.OrgCreatedPayload{OrgID: org, OwnerUserID: owner})
	emit(t, env.pool, outbox.MembershipUpserted, org, outbox.MembershipUpsertedPayload{OrgID: org, UserID: member, Role: "member"})
	emit(t, env.pool, outbox.MembershipUpserted, org, outbox.MembershipUpsertedPayload{OrgID: org, UserID: viewer, Role: "viewer"})
	emit(t, env.pool, outbox.MembershipUpserted, org, outbox.MembershipUpsertedPayload{OrgID: org, UserID: guest, Role: "viewer"})
	emit(t, env.pool, outbox.ProjectCreated, proj, outbox.ProjectCreatedPayload{ProjectID: proj, OrgID: org})
	drain()
	// project.created writes the org_role default.
	if !check(member, authz.ProjectEdit, project) || check(viewer, authz.ProjectEdit, project) || !check(viewer, authz.ProjectView, project) {
		t.Fatal("org_role default: member edits, viewer views")
	}

	// Direct grant: an org viewer becomes project admin.
	emit(t, env.pool, outbox.ProjectMemberUpserted, proj, outbox.ProjectMemberUpsertedPayload{ProjectID: proj, OrgID: org, UserID: guest, Role: "admin"})
	drain()
	if !check(guest, authz.ProjectManageAccess, project) {
		t.Fatal("granted admin cannot manage access")
	}
	// Role change: admin → editor drops admin in the same write.
	emit(t, env.pool, outbox.ProjectMemberUpserted, proj, outbox.ProjectMemberUpsertedPayload{ProjectID: proj, OrgID: org, UserID: guest, Role: "editor"})
	drain()
	if check(guest, authz.ProjectManageAccess, project) || !check(guest, authz.ProjectEdit, project) {
		t.Fatal("role change to editor: wants edit without manage_access")
	}

	// Default access viewer: the member only views; none: restricted.
	emit(t, env.pool, outbox.ProjectAccessChanged, proj, outbox.ProjectAccessChangedPayload{ProjectID: proj, OrgID: org, DefaultAccess: "viewer"})
	drain()
	if check(member, authz.ProjectEdit, project) || !check(member, authz.ProjectView, project) {
		t.Fatal("viewer default: member views only")
	}
	emit(t, env.pool, outbox.ProjectAccessChanged, proj, outbox.ProjectAccessChangedPayload{ProjectID: proj, OrgID: org, DefaultAccess: "none"})
	drain()
	if check(member, authz.ProjectView, project) || check(viewer, authz.ProjectView, project) {
		t.Fatal("restricted project is visible to org members without a grant")
	}
	if !check(owner, authz.ProjectManageAccess, project) || !check(guest, authz.ProjectEdit, project) {
		t.Fatal("restricted project: owner and direct grants keep access")
	}

	// Revoke: the grant is gone and the restricted project is invisible.
	emit(t, env.pool, outbox.ProjectMemberDeleted, proj, outbox.ProjectMemberDeletedPayload{ProjectID: proj, OrgID: org, UserID: guest})
	drain()
	if check(guest, authz.ProjectView, project) {
		t.Fatal("removed project member can still view")
	}

	// Back to org_role, then replay every row: the final state is unchanged.
	emit(t, env.pool, outbox.ProjectAccessChanged, proj, outbox.ProjectAccessChangedPayload{ProjectID: proj, OrgID: org, DefaultAccess: "org_role"})
	drain()
	if _, err := env.pool.Exec(ctx, `UPDATE outbox SET processed_at = NULL`); err != nil {
		t.Fatal(err)
	}
	drain()
	if !check(member, authz.ProjectEdit, project) || check(guest, authz.ProjectEdit, project) || !check(guest, authz.ProjectView, project) {
		t.Fatal("after replay: org_role default with no direct grant for the org viewer")
	}
}

// crashAfterWrite performs the SpiceDB write, then fails as if the process
// died before marking the row processed.
type crashAfterWrite struct {
	outbox.SpiceDB
	writes int
}

var errCrash = errors.New("crash after write")

func (c *crashAfterWrite) WriteRelationships(ctx context.Context, in *v1.WriteRelationshipsRequest, opts ...grpc.CallOption) (*v1.WriteRelationshipsResponse, error) {
	if _, err := c.SpiceDB.WriteRelationships(ctx, in, opts...); err != nil {
		return nil, err
	}
	c.writes++
	return nil, errCrash
}

func TestRelayReappliesAfterCrashBetweenWriteAndMark(t *testing.T) {
	env := newRelayEnv(t)
	ctx := context.Background()
	org, owner, user := uuid.New(), uuid.New(), uuid.New()
	emit(t, env.pool, outbox.OrgCreated, org, outbox.OrgCreatedPayload{OrgID: org, OwnerUserID: owner})
	emit(t, env.pool, outbox.MembershipUpserted, org, outbox.MembershipUpsertedPayload{OrgID: org, UserID: user, Role: "admin"})
	emit(t, env.pool, outbox.MembershipUpserted, org, outbox.MembershipUpsertedPayload{OrgID: org, UserID: user, Role: "member"})

	// First pass: row 1 is written to SpiceDB but never marked.
	crashing := &crashAfterWrite{SpiceDB: env.sdb}
	n, err := outbox.NewRelay(env.pool, crashing, env.authz, outbox.RelayOptions{}, tu.Logger(t), nil).Drain(ctx)
	if !errors.Is(err, errCrash) || n != 0 || crashing.writes != 1 {
		t.Fatalf("crashing pass: applied %d, writes %d, err %v", n, crashing.writes, err)
	}
	if got := pending(t, env.pool); got != 3 {
		t.Fatalf("pending after crash = %d, want 3 (later rows must not overtake)", got)
	}

	// The restarted relay re-applies row 1 (a TOUCH of an existing
	// relationship) and continues in order.
	n, err = outbox.NewRelay(env.pool, env.sdb, env.authz, outbox.RelayOptions{}, tu.Logger(t), nil).Drain(ctx)
	if err != nil || n != 3 {
		t.Fatalf("restarted pass: applied %d, err %v", n, err)
	}
	if got := pending(t, env.pool); got != 0 {
		t.Fatalf("pending = %d, want 0", got)
	}
	orgRes := authz.Organization(org.String())
	for _, c := range []struct {
		u    uuid.UUID
		perm authz.Permission
		want bool
	}{
		{owner, authz.OrgManageBilling, true},
		{user, authz.OrgCreateProject, true}, // member
		{user, authz.OrgManage, false},       // no longer admin
	} {
		if ok, err := env.authz.Check(ctx, authz.User(c.u.String()), c.perm, orgRes); err != nil || ok != c.want {
			t.Errorf("Check(%s, %s) = %v, %v; want %v", c.u, c.perm, ok, err, c.want)
		}
	}

	// Applying already-processed rows again (e.g. a replayed outbox) is a
	// no-op too.
	if _, err := env.pool.Exec(ctx, `UPDATE outbox SET processed_at = NULL`); err != nil {
		t.Fatal(err)
	}
	if n, err := outbox.NewRelay(env.pool, env.sdb, env.authz, outbox.RelayOptions{}, tu.Logger(t), nil).Drain(ctx); err != nil || n != 3 {
		t.Fatalf("replay: applied %d, err %v", n, err)
	}
	if ok, _ := env.authz.Check(ctx, authz.User(user.String()), authz.OrgManage, orgRes); ok {
		t.Error("replay restored the old admin role")
	}
}

func gauge(t *testing.T, reg *prometheus.Registry, name string) float64 {
	t.Helper()
	mfs, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	for _, mf := range mfs {
		if mf.GetName() == name {
			return mf.GetMetric()[0].GetGauge().GetValue()
		}
	}
	t.Fatalf("no metric %s", name)
	return 0
}
