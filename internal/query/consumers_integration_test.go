//go:build integration

package query_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
	"time"

	v1 "github.com/authzed/authzed-go/proto/authzed/api/v1"
	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"

	schema "github.com/apilens/apilens/authz"
	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/apikeys"
	"github.com/apilens/apilens/internal/controlplane/bootstrap"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/migrations"
	"github.com/apilens/apilens/internal/pipeline"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/ch"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/server"
	"github.com/apilens/apilens/internal/platform/spicedb"
	"github.com/apilens/apilens/internal/query"
	"github.com/apilens/apilens/internal/testutil"
)

type groupRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type consumerCounts struct {
	Consumers uint64 `json:"consumers"`
	New       uint64 `json:"new"`
	Returning uint64 `json:"returning"`
}

type consumersList struct {
	BucketSeconds int            `json:"bucket_seconds"`
	Summary       consumerCounts `json:"summary"`
	Points        []struct {
		TS time.Time `json:"ts"`
		consumerCounts
	} `json:"points"`
	Consumers []struct {
		ConsumerID   string    `json:"consumer_id"`
		ConsumerName string    `json:"consumer_name"`
		Group        *groupRef `json:"group"`
		FirstSeen    time.Time `json:"first_seen"`
		LastSeen     time.Time `json:"last_seen"`
		New          bool      `json:"new"`
		split
		Sparkline []uint64 `json:"sparkline"`
	} `json:"consumers"`
}

type consumerDetail struct {
	ConsumerID   string    `json:"consumer_id"`
	ConsumerName string    `json:"consumer_name"`
	Group        *groupRef `json:"group"`
	FirstSeen    time.Time `json:"first_seen"`
	New          bool      `json:"new"`
	Summary      struct {
		split
	} `json:"summary"`
	Points []struct {
		split
	} `json:"points"`
	RecentRequests []struct {
		StatusCode uint16 `json:"status_code"`
		ConsumerID string `json:"consumer_id"`
	} `json:"recent_requests"`
	RecentErrors []struct {
		StatusCode uint16 `json:"status_code"`
	} `json:"recent_errors"`
}

// TestConsumers drives the consumer list and detail against ClickHouse and
// Postgres: new vs returning from first_seen (api_consumers), sparklines,
// groups and project isolation.
func TestConsumers(t *testing.T) {
	ctx := context.Background()
	logger := testutil.Logger(t)
	pool := testutil.MigratedPostgres(t)
	chCfg := testutil.ClickHouse(t)
	if err := migrations.UpClickHouse(ctx, chCfg, logger); err != nil {
		t.Fatal(err)
	}
	conn, err := ch.Connect(ctx, chCfg)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	mine, err := bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "acme", ProjectSlug: "shop", AppSlug: "storefront", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}
	theirs, err := bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "other", ProjectSlug: "bank", AppSlug: "ledger", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}

	srv := server.New(config.ServerConfig{}, slog.New(slog.NewTextHandler(io.Discard, nil)), prometheus.NewRegistry())
	q := db.New(pool)
	verifier := apikeys.NewVerifier(q, apikeys.Options{Size: 100, TTL: time.Minute, NegativeTTL: time.Minute}, logger, nil)
	srv.API().UseMiddleware(query.AuthMiddleware(srv.API(), verifier, nil))
	query.Register(srv.API(), query.NewService(conn, q), nil)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	get := func(key, path string, out any) int {
		t.Helper()
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+path, nil)
		req.Header.Set("Authorization", "Bearer "+key)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		if out != nil && resp.StatusCode == http.StatusOK {
			if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
				t.Fatal(err)
			}
		}
		return resp.StatusCode
	}

	now := time.Now().UTC()
	row := func(p bootstrap.Result, ago time.Duration, code uint16, consumer, name string) pipeline.RequestRow {
		return pipeline.RequestRow{
			ProjectID: p.ProjectID, AppID: p.AppID, Environment: "production", Timestamp: now.Add(-ago),
			Method: "GET", Path: "/orders", RawPath: "/orders", StatusCode: code, ResponseTimeMs: 10, ConsumerID: consumer, ConsumerName: name,
		}
	}
	if err := pipeline.ClickHouseInserters(conn).Requests(ctx, []pipeline.RequestRow{
		// "old" was first seen three days ago and is back in the last hour.
		row(mine, 72*time.Hour, 200, "old", "Old Co"),
		row(mine, 10*time.Minute, 200, "old", "Old Co"),
		row(mine, 8*time.Minute, 200, "old", "Old Co"),
		row(mine, 5*time.Minute, 500, "old", "Old Corp"),
		// "fresh" is first seen in the last hour.
		row(mine, 20*time.Minute, 404, "fresh", "Fresh"),
		row(mine, 2*time.Minute, 200, "fresh", "Fresh"),
		// Requests without a consumer are not a consumer.
		row(mine, 3*time.Minute, 200, "", ""),
		// Another project's "old" is new there and never shows up here.
		row(theirs, 15*time.Minute, 200, "old", "Mallory"),
		row(theirs, 15*time.Minute, 200, "mallory", "Mallory"),
	}); err != nil {
		t.Fatal(err)
	}

	// Groups: "old" goes into Partners, then into Internal, which moves it
	// out of Partners.
	partners, err := q.CreateConsumerGroup(ctx, db.CreateConsumerGroupParams{ID: uuid.New(), ProjectID: mine.ProjectID, Name: "Partners"})
	if err != nil {
		t.Fatal(err)
	}
	internal, err := q.CreateConsumerGroup(ctx, db.CreateConsumerGroupParams{ID: uuid.New(), ProjectID: mine.ProjectID, Name: "Internal"})
	if err != nil {
		t.Fatal(err)
	}
	for _, g := range []uuid.UUID{partners.ID, internal.ID} {
		if _, err := q.AssignConsumerGroup(ctx, db.AssignConsumerGroupParams{ProjectID: mine.ProjectID, ConsumerID: "old", GroupID: g}); err != nil {
			t.Fatal(err)
		}
	}
	// A group of another project cannot take one of mine's consumers.
	foreign, err := q.CreateConsumerGroup(ctx, db.CreateConsumerGroupParams{ID: uuid.New(), ProjectID: theirs.ProjectID, Name: "Partners"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := q.AssignConsumerGroup(ctx, db.AssignConsumerGroupParams{ProjectID: mine.ProjectID, ConsumerID: "fresh", GroupID: foreign.ID}); err == nil {
		t.Fatal("assigning to another project's group should find no group")
	}

	var list consumersList
	if code := get(mine.ReadKey, "/api/v1/consumers?range=1h", &list); code != http.StatusOK {
		t.Fatalf("list: %d", code)
	}
	if list.Summary != (consumerCounts{Consumers: 2, New: 1, Returning: 1}) {
		t.Fatalf("1h summary = %+v", list.Summary)
	}
	if len(list.Consumers) != 2 || list.Consumers[0].ConsumerID != "old" || list.Consumers[1].ConsumerID != "fresh" {
		t.Fatalf("1h consumers = %+v", list.Consumers)
	}
	old, fresh := list.Consumers[0], list.Consumers[1]
	if old.split != (split{3, 2, 0, 1}) || old.ConsumerName != "Old Corp" || old.New {
		t.Fatalf("old = %+v", old)
	}
	if d := now.Add(-72 * time.Hour).Sub(old.FirstSeen); d < -time.Second || d > time.Second {
		t.Fatalf("old first_seen = %v, want %v", old.FirstSeen, now.Add(-72*time.Hour))
	}
	if d := now.Add(-5 * time.Minute).Sub(old.LastSeen); d < -time.Second || d > time.Second {
		t.Fatalf("old last_seen = %v", old.LastSeen)
	}
	if old.Group == nil || old.Group.ID != internal.ID.String() || old.Group.Name != "Internal" {
		t.Fatalf("old group = %+v, want Internal", old.Group)
	}
	if fresh.split != (split{2, 1, 1, 0}) || !fresh.New || fresh.Group != nil {
		t.Fatalf("fresh = %+v", fresh)
	}
	sum := func(xs []uint64) (n uint64) {
		for _, x := range xs {
			n += x
		}
		return n
	}
	if len(old.Sparkline) != 60 || sum(old.Sparkline) != 3 || sum(fresh.Sparkline) != 2 {
		t.Fatalf("sparklines: old %v, fresh %v", old.Sparkline, fresh.Sparkline)
	}
	// Per bucket: old in 3 buckets (returning), fresh first seen in one
	// bucket (new) and back in another (returning).
	var per consumerCounts
	for _, p := range list.Points {
		per.Consumers += p.Consumers
		per.New += p.New
		per.Returning += p.Returning
	}
	if len(list.Points) != 60 || per != (consumerCounts{Consumers: 5, New: 1, Returning: 4}) {
		t.Fatalf("1h points: %d, totals %+v", len(list.Points), per)
	}

	// Over 7 days old's first request falls in the range too: both new.
	if code := get(mine.ReadKey, "/api/v1/consumers?range=7d", &list); code != http.StatusOK {
		t.Fatalf("list 7d: %d", code)
	}
	if list.Summary != (consumerCounts{Consumers: 2, New: 2}) || !list.Consumers[0].New || list.Consumers[0].Requests != 4 {
		t.Fatalf("7d = %+v %+v", list.Summary, list.Consumers)
	}

	// Group filter.
	if code := get(mine.ReadKey, "/api/v1/consumers?range=1h&group="+internal.ID.String(), &list); code != http.StatusOK {
		t.Fatalf("list by group: %d", code)
	}
	if len(list.Consumers) != 1 || list.Consumers[0].ConsumerID != "old" || list.Summary.Consumers != 1 {
		t.Fatalf("group Internal = %+v", list)
	}
	if code := get(mine.ReadKey, "/api/v1/consumers?range=1h&group="+partners.ID.String(), &list); code != http.StatusOK {
		t.Fatalf("list by empty group: %d", code)
	}
	if len(list.Consumers) != 0 || list.Summary.Consumers != 0 || len(list.Points) != 60 {
		t.Fatalf("group Partners (moved out) = %+v", list)
	}

	// Isolation: the other project sees its own "old" as new and nothing of mine.
	list = consumersList{}
	if code := get(theirs.ReadKey, "/api/v1/consumers?range=1h", &list); code != http.StatusOK {
		t.Fatalf("theirs: %d", code)
	}
	var ids []string
	for _, c := range list.Consumers {
		ids = append(ids, c.ConsumerID)
		if !c.New || c.Group != nil {
			t.Fatalf("theirs %s = %+v", c.ConsumerID, c)
		}
	}
	slices.Sort(ids)
	if !slices.Equal(ids, []string{"mallory", "old"}) || list.Summary.New != 2 {
		t.Fatalf("theirs = %v %+v", ids, list.Summary)
	}

	// Detail.
	var d consumerDetail
	if code := get(mine.ReadKey, "/api/v1/consumers/old?range=1h", &d); code != http.StatusOK {
		t.Fatalf("detail: %d", code)
	}
	if d.ConsumerID != "old" || d.ConsumerName != "Old Corp" || d.New || d.Group == nil || d.Group.Name != "Internal" {
		t.Fatalf("detail = %+v", d)
	}
	if d.Summary.split != (split{3, 2, 0, 1}) || len(d.Points) != 60 {
		t.Fatalf("detail summary = %+v, points %d", d.Summary, len(d.Points))
	}
	if len(d.RecentRequests) != 3 || len(d.RecentErrors) != 1 || d.RecentErrors[0].StatusCode != http.StatusInternalServerError {
		t.Fatalf("detail recent = %+v / %+v", d.RecentRequests, d.RecentErrors)
	}
	var fd consumerDetail
	if code := get(mine.ReadKey, "/api/v1/consumers/fresh?range=1h", &fd); code != http.StatusOK || !fd.New || fd.Group != nil || len(fd.RecentErrors) != 1 {
		t.Fatalf("fresh detail: %d %+v", code, fd)
	}
	for _, path := range []string{"/api/v1/consumers/nobody", "/api/v1/consumers/mallory"} {
		if code := get(mine.ReadKey, path, nil); code != http.StatusNotFound {
			t.Fatalf("%s: %d, want 404", path, code)
		}
	}
	if code := get(theirs.ReadKey, "/api/v1/consumers/fresh", nil); code != http.StatusNotFound {
		t.Fatalf("their read key on my consumer: %d, want 404", code)
	}
}

// TestConsumerGroups drives the consumer group CRUD and assignment through
// the API against Postgres and a real SpiceDB.
func TestConsumerGroups(t *testing.T) {
	ctx := context.Background()
	logger := testutil.Logger(t)
	pool := testutil.MigratedPostgres(t)
	sdb, err := spicedb.Connect(testutil.SpiceDB(t))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = sdb.Close() }()
	if err := spicedb.ApplySchema(ctx, sdb, schema.Schema, logger); err != nil {
		t.Fatal(err)
	}
	seed, err := bootstrap.Seed(ctx, pool, bootstrap.Options{OrgSlug: "acme", ProjectSlug: "shop", AppSlug: "storefront", Environment: "production"})
	if err != nil {
		t.Fatal(err)
	}
	member, viewer, outsider := uuid.New(), uuid.New(), uuid.New()
	for i, u := range []uuid.UUID{member, viewer, outsider} {
		email := []string{"member@example.com", "viewer@example.com", "outsider@example.com"}[i]
		if _, err := pool.Exec(ctx, `INSERT INTO users (id, email) VALUES ($1, $2)`, u, email); err != nil {
			t.Fatal(err)
		}
	}
	client := authz.New(sdb, nil, authz.Options{}, logger, nil)
	if _, err := client.WriteRelationships(ctx, seed.OrgID.String(), []*v1.RelationshipUpdate{
		touch("project", seed.ProjectID.String(), "org", "organization", seed.OrgID.String()),
		touch("organization", seed.OrgID.String(), "member", "user", member.String()),
		touch("project", seed.ProjectID.String(), "viewer", "user", viewer.String()),
	}); err != nil {
		t.Fatal(err)
	}

	srv := server.New(config.ServerConfig{}, slog.New(slog.NewTextHandler(io.Discard, nil)), prometheus.NewRegistry())
	api := srv.API()
	api.UseMiddleware(func(hctx huma.Context, next func(huma.Context)) {
		if id := hctx.Header("X-Test-User"); id != "" {
			hctx = huma.WithContext(hctx, authn.WithPrincipal(hctx.Context(), authn.Principal{Kind: authn.KindUser, UserID: uuid.MustParse(id)}))
		}
		next(hctx)
	})
	q := db.New(pool)
	verifier := apikeys.NewVerifier(q, apikeys.Options{Size: 100, TTL: time.Minute, NegativeTTL: time.Minute}, logger, nil)
	guard := authz.NewGuard(client, authz.NewPGResolver(pool), authz.GuardOptions{}, logger)
	api.UseMiddleware(query.AuthMiddleware(api, verifier, guard))
	query.Register(api, query.NewService(nil, q), guard)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	do := func(method, path string, user uuid.UUID, body any, out any) int {
		t.Helper()
		var rd io.Reader
		if body != nil {
			b, _ := json.Marshal(body)
			rd = bytes.NewReader(b)
		}
		req, _ := http.NewRequestWithContext(ctx, method, ts.URL+path, rd)
		if user != uuid.Nil {
			req.Header.Set("X-Test-User", user.String())
		} else {
			req.Header.Set("Authorization", "Bearer "+seed.ReadKey)
		}
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = resp.Body.Close() }()
		if out != nil && resp.StatusCode/100 == 2 {
			if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
				t.Fatal(err)
			}
		}
		return resp.StatusCode
	}
	type group struct {
		ID        string `json:"id"`
		Name      string `json:"name"`
		Consumers int64  `json:"consumers"`
	}
	type groups struct {
		Groups []group `json:"groups"`
	}
	type assignment struct {
		ConsumerID string   `json:"consumer_id"`
		Group      groupRef `json:"group"`
	}
	const base = "/api/v1/projects/shop/consumer-groups"
	const consumer = "/api/v1/projects/shop/consumers/"
	list := func(user uuid.UUID) []group {
		t.Helper()
		var l groups
		if code := do(http.MethodGet, base, user, nil, &l); code != http.StatusOK {
			t.Fatalf("list as %v: %d", user, code)
		}
		return l.Groups
	}

	var partners, internal group
	if code := do(http.MethodPost, base, member, map[string]any{"name": " Partners "}, &partners); code != http.StatusCreated || partners.Name != "Partners" {
		t.Fatalf("create Partners: %d %+v", code, partners)
	}
	if code := do(http.MethodPost, base, member, map[string]any{"name": "Internal"}, &internal); code != http.StatusCreated {
		t.Fatalf("create Internal: %d", code)
	}
	if code := do(http.MethodPost, base, member, map[string]any{"name": "partners"}, nil); code != http.StatusConflict {
		t.Fatalf("duplicate name (other case): %d, want 409", code)
	}
	if code := do(http.MethodPost, base, viewer, map[string]any{"name": "Viewers"}, nil); code != http.StatusForbidden {
		t.Fatalf("viewer creates: %d, want 403", code)
	}
	if code := do(http.MethodPost, base, uuid.Nil, map[string]any{"name": "Keys"}, nil); code != http.StatusUnauthorized {
		t.Fatalf("read key creates: %d, want 401", code)
	}
	if code := do(http.MethodGet, base, outsider, nil, nil); code != http.StatusNotFound {
		t.Fatalf("outsider lists: %d, want 404", code)
	}

	// Assign "acme-mobile" to Partners, then to Internal: it moves.
	var a assignment
	if code := do(http.MethodPut, consumer+"acme-mobile/group", member, map[string]any{"group_id": partners.ID}, &a); code != http.StatusOK || a.Group.Name != "Partners" {
		t.Fatalf("assign to Partners: %d %+v", code, a)
	}
	if code := do(http.MethodPut, consumer+"acme%2Fweb/group", member, map[string]any{"group_id": partners.ID}, &a); code != http.StatusOK || a.ConsumerID != "acme/web" {
		t.Fatalf("assign an id with a slash: %d %+v", code, a)
	}
	if code := do(http.MethodPut, consumer+"acme-mobile/group", member, map[string]any{"group_id": internal.ID}, &a); code != http.StatusOK || a.Group.ID != internal.ID {
		t.Fatalf("move to Internal: %d %+v", code, a)
	}
	counts := map[string]int64{}
	for _, g := range list(uuid.Nil) { // the read key lists groups too
		counts[g.Name] = g.Consumers
	}
	if counts["Partners"] != 1 || counts["Internal"] != 1 || len(counts) != 2 {
		t.Fatalf("after move: %v", counts)
	}
	if code := do(http.MethodPut, consumer+"acme-mobile/group", member, map[string]any{"group_id": uuid.NewString()}, nil); code != http.StatusNotFound {
		t.Fatalf("assign to unknown group: %d, want 404", code)
	}
	if code := do(http.MethodPut, consumer+"acme-mobile/group", viewer, map[string]any{"group_id": partners.ID}, nil); code != http.StatusForbidden {
		t.Fatalf("viewer assigns: %d, want 403", code)
	}

	// Rename, delete, unassign.
	var renamed group
	if code := do(http.MethodPut, base+"/"+internal.ID, member, map[string]any{"name": "Staff"}, &renamed); code != http.StatusOK || renamed.Name != "Staff" || renamed.Consumers != 1 {
		t.Fatalf("rename: %d %+v", code, renamed)
	}
	if code := do(http.MethodPut, base+"/"+internal.ID, member, map[string]any{"name": "PARTNERS"}, nil); code != http.StatusConflict {
		t.Fatalf("rename onto another name: %d, want 409", code)
	}
	if code := do(http.MethodDelete, consumer+"acme%2Fweb/group", member, nil, nil); code != http.StatusNoContent {
		t.Fatalf("unassign: %d", code)
	}
	if code := do(http.MethodDelete, consumer+"acme%2Fweb/group", member, nil, nil); code != http.StatusNotFound {
		t.Fatalf("unassign again: %d, want 404", code)
	}
	if code := do(http.MethodDelete, base+"/"+internal.ID, member, nil, nil); code != http.StatusNoContent {
		t.Fatalf("delete: %d", code)
	}
	if code := do(http.MethodDelete, base+"/"+internal.ID, member, nil, nil); code != http.StatusNotFound {
		t.Fatalf("delete again: %d, want 404", code)
	}
	// Deleting the group left acme-mobile ungrouped.
	if code := do(http.MethodDelete, consumer+"acme-mobile/group", member, nil, nil); code != http.StatusNotFound {
		t.Fatalf("unassign after group deletion: %d, want 404", code)
	}
	if got := list(viewer); len(got) != 1 || got[0].Name != "Partners" || got[0].Consumers != 0 {
		t.Fatalf("final groups: %+v", got)
	}
}
