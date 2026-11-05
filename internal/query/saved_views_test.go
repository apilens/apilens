package query

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/platform/authn"
)

// fakeViewStore keeps saved views in memory.
type fakeViewStore struct {
	SavedViewStore // methods the tests do not use panic
	rows           map[uuid.UUID]db.SavedView
}

func (f *fakeViewStore) GetSavedView(_ context.Context, arg db.GetSavedViewParams) (db.SavedView, error) {
	r, ok := f.rows[arg.ID]
	if !ok || r.ProjectID != arg.ProjectID {
		return db.SavedView{}, pgx.ErrNoRows
	}
	return r, nil
}

func TestNormalizeView(t *testing.T) {
	name, filter, err := normalizeView("  Slow checkouts ", nil)
	if err != nil || name != "Slow checkouts" || string(filter) != "{}" {
		t.Fatalf("got %q %s %v", name, filter, err)
	}
	_, filter, err = normalizeView("x", map[string]any{"status": []any{500.0}, "path": "/orders"})
	if err != nil || string(filter) != `{"path":"/orders","status":[500]}` {
		t.Fatalf("got %s %v", filter, err)
	}
	for _, bad := range []struct {
		name   string
		filter map[string]any
	}{
		{"   ", nil},
		{strings.Repeat("é", maxViewNameLen+1), nil},
		{"big", map[string]any{"q": strings.Repeat("a", maxViewFilterBytes)}},
	} {
		if _, _, err := normalizeView(bad.name, bad.filter); statusOf(err) != http.StatusUnprocessableEntity {
			t.Errorf("normalizeView(%.10q): %v, want 422", bad.name, err)
		}
	}
	if _, _, err := normalizeView(strings.Repeat("é", maxViewNameLen), nil); err != nil {
		t.Errorf("128 runes: %v", err)
	}
}

func TestToSavedView(t *testing.T) {
	u := uuid.New()
	v, err := toSavedView(db.SavedView{ID: uuid.New(), Name: "n", Surface: "explore", Filter: []byte(`{"env":"prod"}`), CreatedBy: &u})
	if err != nil || v.Filter["env"] != "prod" || v.CreatedBy == nil || *v.CreatedBy != u.String() {
		t.Fatalf("got %+v %v", v, err)
	}
	v, err = toSavedView(db.SavedView{ID: uuid.New()})
	if err != nil || v.Filter == nil || v.CreatedBy != nil {
		t.Fatalf("got %+v %v", v, err)
	}
}

func TestSavedViewAccess(t *testing.T) {
	project, other, admin, creator, member := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	shared, private, foreign, orphan := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	store := &fakeViewStore{rows: map[uuid.UUID]db.SavedView{
		shared:  {ID: shared, ProjectID: project, Shared: true, CreatedBy: &creator},
		private: {ID: private, ProjectID: project, CreatedBy: &creator},
		foreign: {ID: foreign, ProjectID: other, Shared: true, CreatedBy: &creator},
		orphan:  {ID: orphan, ProjectID: project, Shared: true},
	}}
	projects := adminProjects{admin: admin, project: project}
	target := authz.Target{ProjectID: project}
	ctx := context.Background()
	user := func(id uuid.UUID) authn.Principal { return authn.Principal{Kind: authn.KindUser, UserID: id} }

	// Reads: shared views for everyone (a nil viewer is a read key),
	// private ones for their creator only, nothing of another project.
	for _, c := range []struct {
		id     uuid.UUID
		viewer *uuid.UUID
		want   int
	}{
		{shared, nil, 0}, {shared, &member, 0}, {private, &creator, 0},
		{private, &member, http.StatusNotFound}, {private, &admin, http.StatusNotFound}, {private, nil, http.StatusNotFound},
		{foreign, &creator, http.StatusNotFound}, {uuid.New(), &creator, http.StatusNotFound},
	} {
		if _, err := visibleView(ctx, store, project, c.id.String(), c.viewer); statusOf(err) != c.want {
			t.Errorf("visibleView(%v, %v) = %v, want %d", c.id, c.viewer, err, c.want)
		}
	}
	if _, err := visibleView(ctx, store, project, "not-a-uuid", &creator); statusOf(err) != http.StatusNotFound {
		t.Errorf("bad id: %v", err)
	}

	// Edits: the creator, or a project admin for shared views.
	for _, c := range []struct {
		name string
		p    authn.Principal
		slug string
		id   uuid.UUID
		want int
	}{
		{"creator shared", user(creator), "shop", shared, 0},
		{"creator private", user(creator), "shop", private, 0},
		{"admin shared", user(admin), "shop", shared, 0},
		{"admin orphan", user(admin), "shop", orphan, 0},
		{"admin private", user(admin), "shop", private, http.StatusNotFound},
		{"member shared", user(member), "shop", shared, http.StatusForbidden},
		{"member orphan", user(member), "shop", orphan, http.StatusForbidden},
		{"authz down", user(admin), "down", shared, http.StatusServiceUnavailable},
		{"slug moved", user(admin), "gone", shared, http.StatusNotFound},
	} {
		if _, err := editableView(ctx, store, projects, c.p, target, c.slug, c.id.String()); statusOf(err) != c.want {
			t.Errorf("%s: %v, want %d", c.name, err, c.want)
		}
	}
	if _, err := editableView(ctx, store, nil, user(member), target, "shop", shared.String()); statusOf(err) != http.StatusServiceUnavailable {
		t.Errorf("nil authorizer: %v", err)
	}
	// The slug resolving to another project is not an admin grant here.
	if _, err := editableView(ctx, store, adminProjects{admin: admin, project: other}, user(admin), target, "shop", shared.String()); statusOf(err) != http.StatusNotFound {
		t.Errorf("other project: %v", err)
	}
}

func TestSavedViewsNeedStore(t *testing.T) {
	s := NewService(nil, &fakeAppStatusCatalog{})
	if _, err := s.viewStore(); statusOf(err) != http.StatusServiceUnavailable {
		t.Fatalf("got %v, want 503", err)
	}
}
