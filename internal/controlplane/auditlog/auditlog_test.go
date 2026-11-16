package auditlog

import (
	"context"
	"slices"
	"testing"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/identity/audit"
)

type fakeChecker struct{ allow map[string]bool }

func (f fakeChecker) CheckBulk(_ context.Context, items []authz.CheckItem) ([]bool, error) {
	out := make([]bool, len(items))
	for i, it := range items {
		out[i] = it.Permission == authz.ProjectView && f.allow[it.Resource.Object.ID]
	}
	return out, nil
}

type fakeProjects []db.ListOrgProjectsRow

func (f fakeProjects) ListOrgProjects(context.Context, uuid.UUID) ([]db.ListOrgProjectsRow, error) {
	return f, nil
}

// fakeEvents returns an org-wide event, one event per project it is asked
// for, and one of a project it was not asked for (a store bug the service
// must not pass on).
type fakeEvents struct {
	visible []uuid.UUID
	extra   uuid.UUID
}

func (f *fakeEvents) ListProject(context.Context, uuid.UUID, audit.Query) (audit.Page, error) {
	return audit.Page{}, nil
}

func (f *fakeEvents) ListOrg(_ context.Context, _ uuid.UUID, visible []uuid.UUID, _ audit.Query) (audit.Page, error) {
	f.visible = visible
	p := audit.Page{Entries: []audit.Entry{{ID: 1, Kind: "member.added"}}}
	for _, id := range append(slices.Clone(visible), f.extra) {
		p.Entries = append(p.Entries, audit.Entry{ID: 2, Kind: "api_key.created", Project: &id})
	}
	return p, nil
}

func TestListOrgKeepsToVisibleProjects(t *testing.T) {
	org, seen, restricted := uuid.New(), uuid.New(), uuid.New()
	events := &fakeEvents{extra: restricted}
	s := NewWith(events, fakeProjects{
		{ID: seen, OrgID: org, Slug: "shop", Name: "Shop"},
		{ID: restricted, OrgID: org, Slug: "vault", Name: "Vault"},
	}, fakeChecker{allow: map[string]bool{seen.String(): true}})

	p, err := s.ListOrg(context.Background(), uuid.New(), org, audit.Query{})
	if err != nil {
		t.Fatal(err)
	}
	if len(events.visible) != 1 || events.visible[0] != seen {
		t.Fatalf("visible = %v", events.visible)
	}
	if len(p.Entries) != 2 || p.Entries[0].ProjectRef != nil || p.Entries[1].ProjectRef == nil || p.Entries[1].ProjectRef.Slug != "shop" {
		t.Fatalf("entries = %+v", p.Entries)
	}
}
