package query

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/platform/authn"
)

type fakeSettingsCatalog struct {
	fakeAppStatusCatalog
	projectSlug string
	rows        map[endpointKey]db.EndpointSetting
}

func (f *fakeSettingsCatalog) GetSettingsApp(_ context.Context, id uuid.UUID) (db.GetSettingsAppRow, error) {
	if id != f.app.ID {
		return db.GetSettingsAppRow{}, pgx.ErrNoRows
	}
	return db.GetSettingsAppRow{ID: id, Slug: f.app.Slug, ProjectID: f.project, ProjectSlug: f.projectSlug}, nil
}

func (f *fakeSettingsCatalog) GetEndpointSettings(_ context.Context, arg db.GetEndpointSettingsParams) (db.EndpointSetting, error) {
	r, ok := f.rows[endpointKey{arg.AppID, arg.Method, arg.Path}]
	if !ok {
		return db.EndpointSetting{}, pgx.ErrNoRows
	}
	return r, nil
}

func (f *fakeSettingsCatalog) UpsertEndpointSettings(_ context.Context, arg db.UpsertEndpointSettingsParams) (db.EndpointSetting, error) {
	r := db.EndpointSetting{
		AppID: arg.AppID, Method: arg.Method, Path: arg.Path, ExpectedStatusCodes: arg.ExpectedStatusCodes,
		LatencyThresholdMs: arg.LatencyThresholdMs, Excluded: arg.Excluded, UpdatedAt: time.Now(), UpdatedBy: arg.UpdatedBy,
	}
	f.rows[endpointKey{arg.AppID, arg.Method, arg.Path}] = r
	return r, nil
}

// adminProjects grants manage_capture on "shop" to admin, view to everyone
// else, and fails on "down".
type adminProjects struct {
	admin   uuid.UUID
	project uuid.UUID
}

func (a adminProjects) AuthorizeProject(_ context.Context, p authn.Principal, slug string, perm authz.Permission) (authz.Target, error) {
	switch {
	case slug == "down":
		return authz.Target{}, fmt.Errorf("%w: refused", authz.ErrUnavailable)
	case slug != "shop":
		return authz.Target{}, authz.ErrNoResource
	case perm == authz.ProjectManageCapture && p.UserID != a.admin:
		return authz.Target{}, authz.ErrForbidden
	}
	return authz.Target{ProjectID: a.project}, nil
}

func statusOf(err error) int {
	var se huma.StatusError
	if errors.As(err, &se) {
		return se.GetStatus()
	}
	return 0
}

func TestEndpointSettingsCRUD(t *testing.T) {
	project, app, admin, member := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	cat := &fakeSettingsCatalog{
		fakeAppStatusCatalog: fakeAppStatusCatalog{project: project, app: db.GetProjectAppRow{ID: app, Slug: "storefront"}},
		projectSlug:          "shop",
		rows:                 map[endpointKey]db.EndpointSetting{},
	}
	s := NewService(nil, cat)
	projects := adminProjects{admin: admin, project: project}
	ref := EndpointRef{ID: app.String(), Method: "get", Path: "/orders/{id}"}
	readCtx := context.WithValue(context.Background(), principalKey{}, scope{ProjectID: project})
	userCtx := func(id uuid.UUID) context.Context {
		return authn.WithPrincipal(context.Background(), authn.Principal{Kind: authn.KindUser, UserID: id})
	}

	// Never saved: the defaults.
	got, err := s.getEndpointSettings(readCtx, &getEndpointSettingsInput{EndpointRef: ref})
	if err != nil {
		t.Fatal(err)
	}
	if b := got.Body; b.Method != http.MethodGet || len(b.ExpectedStatusCodes) != 0 || b.LatencyThresholdMs != nil || b.Excluded || b.UpdatedAt != nil {
		t.Fatalf("defaults = %+v", b)
	}

	put := &putEndpointSettingsInput{EndpointRef: ref}
	threshold := 250
	put.Body.ExpectedStatusCodes = []int{409, 404, 409}
	put.Body.LatencyThresholdMs = &threshold
	put.Body.Excluded = true

	// A member who is not a project admin cannot write.
	if _, err := s.putEndpointSettings(userCtx(member), projects, put); statusOf(err) != http.StatusForbidden {
		t.Fatalf("member put = %v, want 403", err)
	}
	// A read key cannot write.
	keyCtx := authn.WithPrincipal(context.Background(), authn.Principal{Kind: authn.KindAPIKey, ProjectID: project, Scopes: []string{Scope}})
	if _, err := s.putEndpointSettings(keyCtx, projects, put); statusOf(err) != http.StatusUnauthorized {
		t.Fatalf("read key put = %v, want 401", err)
	}

	out, err := s.putEndpointSettings(userCtx(admin), projects, put)
	if err != nil {
		t.Fatal(err)
	}
	if b := out.Body; !slices.Equal(b.ExpectedStatusCodes, []int{404, 409}) || *b.LatencyThresholdMs != 250 || !b.Excluded ||
		b.Method != http.MethodGet || b.UpdatedBy == nil || *b.UpdatedBy != admin.String() {
		t.Fatalf("put = %+v", b)
	}
	got, err = s.getEndpointSettings(readCtx, &getEndpointSettingsInput{EndpointRef: ref})
	if err != nil || !slices.Equal(got.Body.ExpectedStatusCodes, []int{404, 409}) || !got.Body.Excluded {
		t.Fatalf("get after put = %+v, %v", got, err)
	}

	// Validation.
	bad := *put
	bad.Body.ExpectedStatusCodes = []int{99}
	if _, err := s.putEndpointSettings(userCtx(admin), projects, &bad); statusOf(err) != http.StatusUnprocessableEntity {
		t.Errorf("code 99 = %v, want 422", err)
	}
	zero := 0
	bad.Body.ExpectedStatusCodes, bad.Body.LatencyThresholdMs = nil, &zero
	if _, err := s.putEndpointSettings(userCtx(admin), projects, &bad); statusOf(err) != http.StatusUnprocessableEntity {
		t.Errorf("threshold 0 = %v, want 422", err)
	}

	// Unknown app, other project, authz down.
	other := *put
	other.ID = uuid.NewString()
	if _, err := s.putEndpointSettings(userCtx(admin), projects, &other); statusOf(err) != http.StatusNotFound {
		t.Errorf("unknown app put = %v, want 404", err)
	}
	if _, err := s.getEndpointSettings(context.WithValue(context.Background(), principalKey{}, scope{ProjectID: uuid.New()}),
		&getEndpointSettingsInput{EndpointRef: ref}); statusOf(err) != http.StatusNotFound {
		t.Errorf("other project get = %v, want 404", err)
	}
	cat.projectSlug = "down"
	if _, err := s.putEndpointSettings(userCtx(admin), projects, put); statusOf(err) != http.StatusServiceUnavailable {
		t.Errorf("authz down = %v, want 503", err)
	}
	if _, err := s.putEndpointSettings(userCtx(admin), nil, put); statusOf(err) != http.StatusServiceUnavailable {
		t.Errorf("no authorizer = %v, want 503", err)
	}
}

func TestMetricRules(t *testing.T) {
	a, b := uuid.New(), uuid.New()
	r := newMetricRules([]db.ListProjectEndpointSettingsRow{
		{AppID: a, Method: "GET", Path: "/orders/{id}", ExpectedStatusCodes: []int32{200, 404}},
		{AppID: a, Method: "GET", Path: "/health", ExpectedStatusCodes: []int32{503}, Excluded: true},
		{AppID: b, Method: "POST", Path: "/login", ExpectedStatusCodes: []int32{201}},
	})
	if len(r.excluded) != 1 || r.excluded[0].path != "/health" {
		t.Fatalf("excluded = %+v", r.excluded)
	}
	// Excluded endpoints and codes below 400 add no expected rule.
	if len(r.expected) != 1 || !slices.Equal(r.expected[0].codes, []int32{404}) {
		t.Fatalf("expected = %+v", r.expected)
	}
	where, args := r.withoutExcluded("project_id = ?", []any{"p"})
	if where != "project_id = ? AND NOT ((app_id = ? AND method = ? AND path = ?))" || len(args) != 4 || args[3] != "/health" {
		t.Errorf("withoutExcluded = %q %v", where, args)
	}
	pred, pargs := r.expectedPredicate()
	if pred != "((app_id = ? AND method = ? AND path = ? AND status_code IN (404)))" || len(pargs) != 3 {
		t.Errorf("expectedPredicate = %q %v", pred, pargs)
	}

	var none metricRules
	if w, args := none.withoutExcluded("project_id = ?", nil); w != "project_id = ?" || args != nil {
		t.Errorf("no rules = %q", w)
	}
	if p, _ := none.expectedPredicate(); p != "" {
		t.Errorf("no expected = %q", p)
	}

	client, server := uint64(3), uint64(1)
	errorCounts{client: 5, server: 1}.subtract(&client, &server)
	if client != 0 || server != 0 {
		t.Errorf("subtract = %d %d", client, server)
	}
}

func TestNormalizeStatusCodes(t *testing.T) {
	if got, err := normalizeStatusCodes([]int{500, 404, 404}); err != nil || !slices.Equal(got, []int32{404, 500}) {
		t.Errorf("normalize = %v, %v", got, err)
	}
	if got, err := normalizeStatusCodes(nil); err != nil || got == nil || len(got) != 0 {
		t.Errorf("empty = %v, %v", got, err)
	}
	for _, bad := range [][]int{{600}, {0}} {
		if _, err := normalizeStatusCodes(bad); statusOf(err) != http.StatusUnprocessableEntity {
			t.Errorf("%v = %v, want 422", bad, err)
		}
	}
}
