package authz

import (
	"context"
	"errors"
	"net"
	"sync"
	"testing"
	"time"

	v1 "github.com/authzed/authzed-go/proto/authzed/api/v1"
	"github.com/prometheus/client_golang/prometheus"
	promtest "github.com/prometheus/client_golang/prometheus/testutil"
	rpcstatus "google.golang.org/genproto/googleapis/rpc/status"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"
)

// fakeSpiceDB is a PermissionsService that grants exactly the tuples in
// allowed ("user:u#perm@project:p") and records what it was asked.
type fakeSpiceDB struct {
	v1.UnimplementedPermissionsServiceServer

	mu          sync.Mutex
	allowed     map[string]bool
	conditional map[string]bool
	itemErrors  map[string]bool
	down        bool // answer Unavailable
	calls       int
	consistency []*v1.Consistency
	written     int
}

func tuple(subject *v1.SubjectReference, perm string, res *v1.ObjectReference) string {
	return subject.GetObject().GetObjectType() + ":" + subject.GetObject().GetObjectId() + "#" + perm + "@" + res.GetObjectType() + ":" + res.GetObjectId()
}

func (f *fakeSpiceDB) begin(c *v1.Consistency) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	f.consistency = append(f.consistency, c)
	if f.down {
		return status.Error(codes.Unavailable, "spicedb is down")
	}
	return nil
}

func (f *fakeSpiceDB) permissionship(subject *v1.SubjectReference, perm string, res *v1.ObjectReference) v1.CheckPermissionResponse_Permissionship {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch t := tuple(subject, perm, res); {
	case f.allowed[t]:
		return v1.CheckPermissionResponse_PERMISSIONSHIP_HAS_PERMISSION
	case f.conditional[t]:
		return v1.CheckPermissionResponse_PERMISSIONSHIP_CONDITIONAL_PERMISSION
	default:
		return v1.CheckPermissionResponse_PERMISSIONSHIP_NO_PERMISSION
	}
}

func (f *fakeSpiceDB) CheckPermission(_ context.Context, req *v1.CheckPermissionRequest) (*v1.CheckPermissionResponse, error) {
	if err := f.begin(req.GetConsistency()); err != nil {
		return nil, err
	}
	return &v1.CheckPermissionResponse{Permissionship: f.permissionship(req.GetSubject(), req.GetPermission(), req.GetResource())}, nil
}

func (f *fakeSpiceDB) CheckBulkPermissions(_ context.Context, req *v1.CheckBulkPermissionsRequest) (*v1.CheckBulkPermissionsResponse, error) {
	if err := f.begin(req.GetConsistency()); err != nil {
		return nil, err
	}
	resp := &v1.CheckBulkPermissionsResponse{}
	for _, it := range req.GetItems() {
		pair := &v1.CheckBulkPermissionsPair{Request: it}
		if f.itemErrors[tuple(it.GetSubject(), it.GetPermission(), it.GetResource())] {
			pair.Response = &v1.CheckBulkPermissionsPair_Error{Error: &rpcstatus.Status{Code: int32(codes.Internal), Message: "boom"}}
		} else {
			pair.Response = &v1.CheckBulkPermissionsPair_Item{Item: &v1.CheckBulkPermissionsResponseItem{
				Permissionship: f.permissionship(it.GetSubject(), it.GetPermission(), it.GetResource()),
			}}
		}
		resp.Pairs = append(resp.Pairs, pair)
	}
	return resp, nil
}

func (f *fakeSpiceDB) LookupResources(req *v1.LookupResourcesRequest, stream grpc.ServerStreamingServer[v1.LookupResourcesResponse]) error {
	if err := f.begin(req.GetConsistency()); err != nil {
		return err
	}
	for _, id := range []string{"p1", "p2", "p3"} {
		ps := v1.LookupPermissionship_LOOKUP_PERMISSIONSHIP_HAS_PERMISSION
		switch f.permissionship(req.GetSubject(), req.GetPermission(), &v1.ObjectReference{ObjectType: req.GetResourceObjectType(), ObjectId: id}) {
		case v1.CheckPermissionResponse_PERMISSIONSHIP_HAS_PERMISSION:
		case v1.CheckPermissionResponse_PERMISSIONSHIP_CONDITIONAL_PERMISSION:
			ps = v1.LookupPermissionship_LOOKUP_PERMISSIONSHIP_CONDITIONAL_PERMISSION
		default:
			continue
		}
		if err := stream.Send(&v1.LookupResourcesResponse{ResourceObjectId: id, Permissionship: ps}); err != nil {
			return err
		}
	}
	return nil
}

func (f *fakeSpiceDB) WriteRelationships(_ context.Context, req *v1.WriteRelationshipsRequest) (*v1.WriteRelationshipsResponse, error) {
	if err := f.begin(nil); err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.written++
	for _, u := range req.GetUpdates() {
		r := u.GetRelationship()
		f.allowed[tuple(r.GetSubject(), r.GetRelation(), r.GetResource())] = u.GetOperation() != v1.RelationshipUpdate_OPERATION_DELETE
	}
	return &v1.WriteRelationshipsResponse{WrittenAt: &v1.ZedToken{Token: "token-" + string(rune('0'+f.written))}}, nil
}

func (f *fakeSpiceDB) lastConsistency() *v1.Consistency {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.consistency[len(f.consistency)-1]
}

func (f *fakeSpiceDB) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

// memTokens is an in-memory TokenStore; err makes every call fail.
type memTokens struct {
	mu  sync.Mutex
	m   map[string]string
	err error
}

func (s *memTokens) Get(_ context.Context, org string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.m[org], s.err
}

func (s *memTokens) Set(_ context.Context, org, token string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return s.err
	}
	s.m[org] = token
	return nil
}

type harness struct {
	fake   *fakeSpiceDB
	tokens *memTokens
	client *Client
	reg    *prometheus.Registry
	stop   func()
}

func newHarness(t *testing.T, opts Options) *harness {
	t.Helper()
	fake := &fakeSpiceDB{allowed: map[string]bool{}, conditional: map[string]bool{}, itemErrors: map[string]bool{}}
	lis := bufconn.Listen(1 << 20)
	srv := grpc.NewServer()
	v1.RegisterPermissionsServiceServer(srv, fake)
	go func() { _ = srv.Serve(lis) }()
	conn, err := grpc.NewClient("passthrough:///bufnet",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) { return lis.DialContext(ctx) }),
		grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(); srv.Stop() })
	if opts.Timeout == 0 {
		opts.Timeout = time.Second
	}
	tokens := &memTokens{m: map[string]string{}}
	reg := prometheus.NewRegistry()
	return &harness{
		fake: fake, tokens: tokens, reg: reg,
		client: New(v1.NewPermissionsServiceClient(conn), tokens, opts, nil, reg),
		stop:   srv.Stop,
	}
}

func (h *harness) errorsTotal(op string) float64 {
	return promtest.ToFloat64(h.client.m.errors.WithLabelValues(op))
}

var (
	alice = User("alice")
	p1    = Project("acme", "p1")
)

func TestCheck(t *testing.T) {
	h := newHarness(t, Options{})
	h.fake.allowed["user:alice#view@project:p1"] = true
	h.fake.conditional["user:alice#edit@project:p1"] = true
	ctx := context.Background()

	for _, tc := range []struct {
		perm Permission
		want bool
	}{{ProjectView, true}, {ProjectEdit, false}, {ProjectDelete, false}} {
		got, err := h.client.Check(ctx, alice, tc.perm, p1)
		if err != nil || got != tc.want {
			t.Errorf("Check(%s) = %v, %v; want %v, nil", tc.perm, got, err, tc.want)
		}
	}
	if n := promtest.ToFloat64(h.client.m.checks.WithLabelValues("check", "denied")); n != 2 {
		t.Errorf("denied checks = %v, want 2", n)
	}
}

func TestCheckFailsClosedOnOutage(t *testing.T) {
	h := newHarness(t, Options{CacheTTL: time.Minute})
	h.fake.allowed["user:alice#view@project:p1"] = true
	ctx := context.Background()

	// SpiceDB answers Unavailable.
	h.fake.down = true
	ok, err := h.client.Check(ctx, alice, ProjectView, p1)
	if ok || !errors.Is(err, ErrUnavailable) {
		t.Fatalf("Check while down = %v, %v; want false, ErrUnavailable", ok, err)
	}
	if n := h.errorsTotal("check"); n != 1 {
		t.Fatalf("apilens_authz_errors_total = %v, want 1", n)
	}

	// SpiceDB is gone entirely (connection refused).
	h.stop()
	ok, err = h.client.Check(ctx, alice, ProjectView, p1)
	if ok || !errors.Is(err, ErrUnavailable) {
		t.Fatalf("Check after stop = %v, %v; want false, ErrUnavailable", ok, err)
	}
	res, err := h.client.CheckBulk(ctx, []CheckItem{{alice, ProjectView, p1}, {alice, ProjectEdit, p1}})
	if !errors.Is(err, ErrUnavailable) || res[0] || res[1] {
		t.Fatalf("CheckBulk after stop = %v, %v; want all false, ErrUnavailable", res, err)
	}
	ids, err := h.client.LookupResources(ctx, "acme", alice, ProjectView, TypeProject)
	if ids != nil || !errors.Is(err, ErrUnavailable) {
		t.Fatalf("LookupResources after stop = %v, %v; want nil, ErrUnavailable", ids, err)
	}
	if n := h.errorsTotal("check"); n != 2 {
		t.Fatalf("check errors = %v, want 2", n)
	}
	if n := h.errorsTotal("check_bulk"); n != 1 {
		t.Fatalf("check_bulk errors = %v, want 1", n)
	}
	if n := h.errorsTotal("lookup_resources"); n != 1 {
		t.Fatalf("lookup errors = %v, want 1", n)
	}
}

func TestCheckTimesOut(t *testing.T) {
	// A server that never answers must not hang the request.
	lis := bufconn.Listen(1 << 20)
	t.Cleanup(func() { _ = lis.Close() })
	conn, err := grpc.NewClient("passthrough:///bufnet",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) { return lis.DialContext(ctx) }),
		grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	c := New(v1.NewPermissionsServiceClient(conn), nil, Options{Timeout: 50 * time.Millisecond}, nil, nil)
	start := time.Now()
	ok, err := c.Check(context.Background(), alice, ProjectView, p1)
	if ok || !errors.Is(err, ErrUnavailable) {
		t.Fatalf("Check = %v, %v; want false, ErrUnavailable", ok, err)
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("Check took %v", d)
	}
}

func TestNotConfiguredDenies(t *testing.T) {
	c := New(nil, nil, Options{}, nil, nil)
	ctx := context.Background()
	if ok, err := c.Check(ctx, alice, ProjectView, p1); ok || !errors.Is(err, ErrUnavailable) {
		t.Fatalf("Check = %v, %v", ok, err)
	}
	if res, err := c.CheckBulk(ctx, []CheckItem{{alice, ProjectView, p1}}); res[0] || !errors.Is(err, ErrUnavailable) {
		t.Fatalf("CheckBulk = %v, %v", res, err)
	}
	if ids, err := c.LookupResources(ctx, "", alice, ProjectView, TypeProject); ids != nil || !errors.Is(err, ErrUnavailable) {
		t.Fatalf("LookupResources = %v, %v", ids, err)
	}
	if _, err := c.WriteRelationships(ctx, "acme", nil); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("WriteRelationships err = %v", err)
	}
}

func TestCacheAllowedOnlyAndKeyedByToken(t *testing.T) {
	h := newHarness(t, Options{CacheTTL: time.Minute})
	h.fake.allowed["user:alice#view@project:p1"] = true
	ctx := context.Background()

	for range 3 {
		if ok, _ := h.client.Check(ctx, alice, ProjectView, p1); !ok {
			t.Fatal("want allowed")
		}
		if ok, _ := h.client.Check(ctx, alice, ProjectEdit, p1); ok {
			t.Fatal("want denied")
		}
	}
	// 1 call for the cached allow, 3 for the uncached denials.
	if n := h.fake.callCount(); n != 4 {
		t.Fatalf("spicedb calls = %d, want 4", n)
	}
	if n := promtest.ToFloat64(h.client.m.hits); n != 2 {
		t.Fatalf("cache hits = %v, want 2", n)
	}

	// A write to the org changes the token: the cached allow is bypassed and
	// the revocation is seen immediately.
	if _, err := h.client.WriteRelationships(ctx, "acme", []*v1.RelationshipUpdate{{
		Operation: v1.RelationshipUpdate_OPERATION_DELETE,
		Relationship: &v1.Relationship{
			Resource: p1.ref(), Relation: "view", Subject: alice.subject(),
		},
	}}); err != nil {
		t.Fatal(err)
	}
	if ok, _ := h.client.Check(ctx, alice, ProjectView, p1); ok {
		t.Fatal("revoked permission served from cache")
	}
}

func TestCacheDisabled(t *testing.T) {
	h := newHarness(t, Options{})
	h.fake.allowed["user:alice#view@project:p1"] = true
	for range 2 {
		_, _ = h.client.Check(context.Background(), alice, ProjectView, p1)
	}
	if n := h.fake.callCount(); n != 2 {
		t.Fatalf("spicedb calls = %d, want 2 (cache off)", n)
	}
}

func TestConsistency(t *testing.T) {
	h := newHarness(t, Options{CacheTTL: time.Minute})
	h.fake.allowed["user:alice#view@project:p1"] = true
	ctx := context.Background()

	// No write recorded: minimize_latency.
	_, _ = h.client.Check(ctx, alice, ProjectView, p1)
	if !h.fake.lastConsistency().GetMinimizeLatency() {
		t.Fatalf("consistency = %v, want minimize_latency", h.fake.lastConsistency())
	}

	// After a write: at_least_as_fresh the stored token.
	token, err := h.client.WriteRelationships(ctx, "acme", nil)
	if err != nil {
		t.Fatal(err)
	}
	if h.tokens.m["acme"] != token || token == "" {
		t.Fatalf("stored token = %q, want %q", h.tokens.m["acme"], token)
	}
	_, _ = h.client.Check(ctx, alice, ProjectView, p1)
	if got := h.fake.lastConsistency().GetAtLeastAsFresh().GetToken(); got != token {
		t.Fatalf("at_least_as_fresh = %q, want %q", got, token)
	}

	// Token store down: fully consistent, and the cache is bypassed.
	h.tokens.err = errors.New("valkey down")
	before := h.fake.callCount()
	for range 2 {
		if ok, err := h.client.Check(ctx, alice, ProjectView, p1); !ok || err != nil {
			t.Fatalf("Check = %v, %v", ok, err)
		}
		if !h.fake.lastConsistency().GetFullyConsistent() {
			t.Fatalf("consistency = %v, want fully_consistent", h.fake.lastConsistency())
		}
	}
	if n := h.fake.callCount() - before; n != 2 {
		t.Fatalf("spicedb calls = %d, want 2 (no caching without a token)", n)
	}
	// A failed token write does not fail the relationship write.
	if _, err := h.client.WriteRelationships(ctx, "acme", nil); err != nil {
		t.Fatalf("write with token store down: %v", err)
	}
}

func TestCheckBulk(t *testing.T) {
	h := newHarness(t, Options{CacheTTL: time.Minute})
	h.fake.allowed["user:alice#view@project:p1"] = true
	h.fake.allowed["user:alice#manage@organization:acme"] = true
	h.fake.itemErrors["user:alice#delete@project:p1"] = true
	ctx := context.Background()

	items := []CheckItem{
		{alice, ProjectView, p1},
		{alice, ProjectEdit, p1},
		{alice, OrgManage, Organization("acme")},
		{alice, ProjectDelete, p1},
	}
	res, err := h.client.CheckBulk(ctx, items)
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err = %v, want per-item ErrUnavailable", err)
	}
	if want := []bool{true, false, true, false}; !equal(res, want) {
		t.Fatalf("results = %v, want %v", res, want)
	}
	if n := h.errorsTotal("check_bulk"); n != 1 {
		t.Fatalf("errors = %v, want 1", n)
	}

	// Allowed answers are now cached: only the rest go to SpiceDB.
	before := h.fake.callCount()
	res, _ = h.client.CheckBulk(ctx, items[:1])
	if !res[0] || h.fake.callCount() != before {
		t.Fatalf("cached bulk item: res=%v calls=%d", res, h.fake.callCount()-before)
	}
	if ok, _ := h.client.Check(ctx, alice, OrgManage, Organization("acme")); !ok || h.fake.callCount() != before {
		t.Fatal("Check did not reuse the bulk result")
	}

	if res, err := h.client.CheckBulk(ctx, nil); err != nil || len(res) != 0 {
		t.Fatalf("empty bulk = %v, %v", res, err)
	}
}

func TestCheckBulkConsistencyAcrossOrgs(t *testing.T) {
	h := newHarness(t, Options{})
	ctx := context.Background()
	items := []CheckItem{{alice, ProjectView, p1}, {alice, ProjectView, Project("globex", "p9")}}

	_, _ = h.client.CheckBulk(ctx, items)
	if !h.fake.lastConsistency().GetMinimizeLatency() {
		t.Fatalf("no tokens: consistency = %v", h.fake.lastConsistency())
	}
	_ = h.client.RecordToken(ctx, "acme", "t-acme")
	_, _ = h.client.CheckBulk(ctx, items)
	if got := h.fake.lastConsistency().GetAtLeastAsFresh().GetToken(); got != "t-acme" {
		t.Fatalf("one token: at_least_as_fresh = %q", got)
	}
	_ = h.client.RecordToken(ctx, "globex", "t-globex")
	_, _ = h.client.CheckBulk(ctx, items)
	if !h.fake.lastConsistency().GetFullyConsistent() {
		t.Fatalf("two tokens: consistency = %v, want fully_consistent", h.fake.lastConsistency())
	}
}

func TestLookupResources(t *testing.T) {
	h := newHarness(t, Options{})
	h.fake.allowed["user:alice#view@project:p1"] = true
	h.fake.allowed["user:alice#view@project:p3"] = true
	h.fake.conditional["user:alice#view@project:p2"] = true
	ctx := context.Background()

	ids, err := h.client.LookupResources(ctx, "", alice, ProjectView, TypeProject)
	if err != nil || !equal(ids, []string{"p1", "p3"}) {
		t.Fatalf("LookupResources = %v, %v; want [p1 p3]", ids, err)
	}
	if !h.fake.lastConsistency().GetFullyConsistent() {
		t.Fatalf("no org: consistency = %v, want fully_consistent", h.fake.lastConsistency())
	}
	_ = h.client.RecordToken(ctx, "acme", "t1")
	if _, err := h.client.LookupResources(ctx, "acme", alice, ProjectView, TypeProject); err != nil {
		t.Fatal(err)
	}
	if got := h.fake.lastConsistency().GetAtLeastAsFresh().GetToken(); got != "t1" {
		t.Fatalf("at_least_as_fresh = %q, want t1", got)
	}
	ids, err = h.client.LookupResources(ctx, "acme", User("bob"), ProjectView, TypeProject)
	if err != nil || ids == nil || len(ids) != 0 {
		t.Fatalf("no grants = %#v, %v; want empty, non-nil", ids, err)
	}
}

func equal[T comparable](a, b []T) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
