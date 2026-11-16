package catalog

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/controlplane/apps"
	"github.com/apilens/apilens/internal/controlplane/store/db"
)

type fakeApps struct {
	mu      sync.Mutex
	rows    []db.ListResolverAppsRow
	aliases []db.ListProjectAppAliasesRow
	calls   int
}

func (f *fakeApps) ListResolverApps(context.Context, db.ListResolverAppsParams) ([]db.ListResolverAppsRow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	return append([]db.ListResolverAppsRow(nil), f.rows...), nil
}

func (f *fakeApps) ListProjectAppAliases(context.Context, uuid.UUID) ([]db.ListProjectAppAliasesRow, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]db.ListProjectAppAliasesRow(nil), f.aliases...), nil
}

func (f *fakeApps) add(row db.ListResolverAppsRow) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.rows = append(f.rows, row)
}

// fakeProv creates apps in the fake store.
type fakeProv struct {
	store      *fakeApps
	err        error
	created    []string
	unarchived []uuid.UUID
	defaults   int
}

func (p *fakeProv) Create(_ context.Context, _, _ uuid.UUID, slug, _ string) (uuid.UUID, bool, error) {
	if p.err != nil {
		return uuid.Nil, false, p.err
	}
	id := uuid.New()
	p.created = append(p.created, slug)
	p.store.add(db.ListResolverAppsRow{ID: id, Slug: slug})
	return id, true, nil
}

func (p *fakeProv) EnsureDefault(context.Context, uuid.UUID) (uuid.UUID, error) {
	p.defaults++
	id := uuid.New()
	p.store.add(db.ListResolverAppsRow{ID: id, Slug: "default", IsDefault: true})
	return id, nil
}

func (p *fakeProv) Unarchive(_ context.Context, _, appID, _ uuid.UUID) error {
	p.unarchived = append(p.unarchived, appID)
	p.store.mu.Lock()
	defer p.store.mu.Unlock()
	for i := range p.store.rows {
		if p.store.rows[i].ID == appID {
			p.store.rows[i].ArchivedAt = nil
		}
	}
	return nil
}

var canCreate = Caller{KeyID: uuid.New(), ProjectSlug: "shop", CanCreate: true}

func TestResolveSlugsIDsAndNames(t *testing.T) {
	shop, orders := uuid.New(), uuid.New()
	f := &fakeApps{rows: []db.ListResolverAppsRow{{ID: shop, Slug: "shop", IsDefault: true}, {ID: orders, Slug: "orders-api"}}}
	r := NewAppResolver(f, time.Minute)

	got, err := r.Resolve(context.Background(), uuid.New(), []string{"shop", orders.String(), "Orders API", " orders_api ", ""})
	if err != nil {
		t.Fatal(err)
	}
	if got["shop"] != shop || got[orders.String()] != orders || got["Orders API"] != orders || got["orders_api"] != orders || got[""] != shop {
		t.Fatalf("got %v", got)
	}
}

func TestResolveUnknownRefreshesOnce(t *testing.T) {
	f := &fakeApps{rows: []db.ListResolverAppsRow{{ID: uuid.New(), Slug: "shop"}}}
	r := NewAppResolver(f, time.Minute)
	r.minRefresh = 0
	pid := uuid.New()

	_, err := r.Resolve(context.Background(), pid, []string{"shop", "ghost", uuid.NewString()})
	var unknown *UnknownAppsError
	if !errors.As(err, &unknown) || len(unknown.Identifiers) != 2 {
		t.Fatalf("err = %v", err)
	}
	if f.calls != 2 {
		t.Fatalf("calls = %d, want 2 (initial load + one forced refresh)", f.calls)
	}

	// An app created elsewhere is found via the forced refresh.
	ghost := uuid.New()
	f.add(db.ListResolverAppsRow{ID: ghost, Slug: "ghost"})
	got, err := r.Resolve(context.Background(), pid, []string{"ghost"})
	if err != nil || got["ghost"] != ghost {
		t.Fatalf("got %v err %v", got, err)
	}
}

func TestResolveForCreatesUnknownApps(t *testing.T) {
	f := &fakeApps{rows: []db.ListResolverAppsRow{{ID: uuid.New(), Slug: "shop", IsDefault: true}}}
	prov := &fakeProv{store: f}
	r := NewAppResolver(f, time.Minute).WithProvisioner(prov)
	pid := uuid.New()

	res, err := r.ResolveFor(context.Background(), pid, canCreate, []string{"Orders API", "orders-api", "shop"})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Rejected) != 0 || res.Apps["Orders API"] == uuid.Nil || res.Apps["Orders API"] != res.Apps["orders-api"] {
		t.Fatalf("res = %+v", res)
	}
	if len(prov.created) != 1 || prov.created[0] != "orders-api" || len(res.Created) != 1 {
		t.Fatalf("created %v (%v)", prov.created, res.Created)
	}
	// The cache picked the new app up at once: no second create.
	again, err := r.ResolveFor(context.Background(), pid, canCreate, []string{"ORDERS api"})
	if err != nil || again.Apps["ORDERS api"] != res.Apps["orders-api"] || len(prov.created) != 1 {
		t.Fatalf("again %+v err %v created %v", again, err, prov.created)
	}
}

func TestResolveForPermissions(t *testing.T) {
	shop := uuid.New()
	f := &fakeApps{rows: []db.ListResolverAppsRow{{ID: shop, Slug: "shop", IsDefault: true}, {ID: uuid.New(), Slug: "billing"}}}
	prov := &fakeProv{store: f}
	r := NewAppResolver(f, time.Minute).WithProvisioner(prov)
	ctx, pid := context.Background(), uuid.New()

	res, _ := r.ResolveFor(ctx, pid, Caller{ProjectSlug: "shop"}, []string{"newsvc", "shop"})
	if rej := res.Rejected["newsvc"]; rej.Reason != ReasonCreateForbidden || !strings.Contains(rej.Message, `"newsvc"`) || !strings.Contains(rej.Message, "cannot create apps") {
		t.Fatalf("no permission: %+v", rej)
	}
	if res.Apps["shop"] != shop || len(prov.created) != 0 {
		t.Fatalf("known app must pass: %+v", res)
	}

	scoped := Caller{ProjectSlug: "shop", CanCreate: true, AppIDs: []uuid.UUID{shop}}
	res, _ = r.ResolveFor(ctx, pid, scoped, []string{"shop", "billing", "newsvc"})
	if res.Apps["shop"] != shop {
		t.Fatalf("in scope: %+v", res)
	}
	if res.Rejected["billing"].Reason != ReasonNotAllowed || res.Rejected["billing"].AppID == uuid.Nil {
		t.Fatalf("out of scope: %+v", res.Rejected["billing"])
	}
	if rej := res.Rejected["newsvc"]; rej.Reason != ReasonNotAllowed || !strings.Contains(rej.Message, "cannot create apps") {
		t.Fatalf("scoped create: %+v", rej)
	}
	if len(prov.created) != 0 {
		t.Fatalf("created %v", prov.created)
	}
}

func TestResolveForDefaultApp(t *testing.T) {
	f := &fakeApps{rows: []db.ListResolverAppsRow{{ID: uuid.New(), Slug: "other"}}}
	prov := &fakeProv{store: f}
	r := NewAppResolver(f, time.Minute).WithProvisioner(prov)
	res, err := r.ResolveFor(context.Background(), uuid.New(), Caller{}, []string{""})
	if err != nil || res.Apps[""] == uuid.Nil || prov.defaults != 1 {
		t.Fatalf("res %+v err %v defaults %d", res, err, prov.defaults)
	}
	// Records without an app reach the default app even for a key that cannot create apps.
	res, _ = r.ResolveFor(context.Background(), uuid.New(), Caller{}, []string{"  "})
	if res.Apps[""] == uuid.Nil {
		t.Fatalf("blank = default: %+v", res)
	}
}

func TestResolveForArchivedDeletedAliasesMerged(t *testing.T) {
	now := time.Now()
	archived, target, merged := uuid.New(), uuid.New(), uuid.New()
	f := &fakeApps{
		rows: []db.ListResolverAppsRow{
			{ID: archived, Slug: "old", ArchivedAt: &now},
			{ID: target, Slug: "orders"},
			{ID: merged, Slug: "ordrs", ArchivedAt: &now, MergedInto: &target},
			{ID: uuid.New(), Slug: "gone", DeletedAt: &now},
		},
		aliases: []db.ListProjectAppAliasesRow{{AliasSlug: "ordrs", AppID: target}, {AliasSlug: "order", AppID: target}},
	}
	prov := &fakeProv{store: f}
	r := NewAppResolver(f, time.Minute).WithProvisioner(prov)
	res, err := r.ResolveFor(context.Background(), uuid.New(), canCreate, []string{"old", "ordrs", "order", merged.String(), "gone"})
	if err != nil {
		t.Fatal(err)
	}
	if res.Apps["old"] != archived || len(prov.unarchived) != 1 || prov.unarchived[0] != archived {
		t.Fatalf("archived app un-archived: %+v %v", res, prov.unarchived)
	}
	if res.Apps["ordrs"] != target || res.Apps["order"] != target || res.Apps[merged.String()] != target {
		t.Fatalf("aliases and merged ids route to the target: %+v", res.Apps)
	}
	if rej := res.Rejected["gone"]; rej.Reason != ReasonDeleted || !strings.Contains(rej.Message, "app gone was deleted on") || !strings.Contains(rej.Message, "restore it from Apps") {
		t.Fatalf("deleted: %+v", rej)
	}
	if len(prov.created) != 0 {
		t.Fatalf("created %v", prov.created)
	}
}

func TestResolveForLimitsAndBadNames(t *testing.T) {
	f := &fakeApps{rows: []db.ListResolverAppsRow{{ID: uuid.New(), Slug: "shop"}}}
	prov := &fakeProv{store: f, err: &apps.LimitError{Limit: apps.LimitMaxApps, Max: 50}}
	r := NewAppResolver(f, time.Minute).WithProvisioner(prov)
	ctx, pid := context.Background(), uuid.New()

	res, _ := r.ResolveFor(ctx, pid, canCreate, []string{"a-new-one", "shop", "!!!", uuid.NewString()})
	if rej := res.Rejected["a-new-one"]; rej.Reason != ReasonAppLimit || !strings.Contains(rej.Message, "already has 50 apps") {
		t.Fatalf("limit: %+v", rej)
	}
	if res.Apps["shop"] == uuid.Nil {
		t.Fatal("other apps of the batch still resolve")
	}
	if res.Rejected["!!!"].Reason != ReasonInvalidName {
		t.Fatalf("bad name: %+v", res.Rejected["!!!"])
	}
	for id, rej := range res.Rejected {
		if _, err := uuid.Parse(id); err == nil && rej.Reason != ReasonUnknown {
			t.Fatalf("unknown uuid: %+v", rej)
		}
	}

	// The rejection is remembered briefly: no second attempt.
	prov.err = &apps.LimitError{Limit: apps.LimitMaxNewPerHour, Max: 10}
	res, _ = r.ResolveFor(ctx, pid, canCreate, []string{"a-new-one"})
	if res.Rejected["a-new-one"].Reason != ReasonAppLimit {
		t.Fatalf("remembered: %+v", res.Rejected)
	}
	r.Forget(pid)
	res, _ = r.ResolveFor(ctx, pid, canCreate, []string{"a-new-one"})
	if rej := res.Rejected["a-new-one"]; rej.Reason != ReasonRateLimit || !strings.Contains(rej.Message, "in the last hour") {
		t.Fatalf("rate limit: %+v", rej)
	}
	prov.err = &apps.DeletedError{Slug: "a-new-one", DeletedAt: time.Now()}
	r.Forget(pid)
	res, _ = r.ResolveFor(ctx, pid, canCreate, []string{"a-new-one"})
	if res.Rejected["a-new-one"].Reason != ReasonDeleted {
		t.Fatalf("deleted during create: %+v", res.Rejected)
	}
}
