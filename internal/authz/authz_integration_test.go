//go:build integration

package authz_test

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	v1 "github.com/authzed/authzed-go/proto/authzed/api/v1"

	schema "github.com/apilens/apilens/authz"
	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/platform/cache"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/spicedb"
	"github.com/apilens/apilens/internal/testutil"
)

func rel(op v1.RelationshipUpdate_Operation, resType, resID, relation, userID string) *v1.RelationshipUpdate {
	return &v1.RelationshipUpdate{Operation: op, Relationship: &v1.Relationship{
		Resource: &v1.ObjectReference{ObjectType: resType, ObjectId: resID},
		Relation: relation,
		Subject:  &v1.SubjectReference{Object: &v1.ObjectReference{ObjectType: "user", ObjectId: userID}},
	}}
}

func orgOf(projectID, orgID string) *v1.RelationshipUpdate {
	return &v1.RelationshipUpdate{Operation: v1.RelationshipUpdate_OPERATION_TOUCH, Relationship: &v1.Relationship{
		Resource: &v1.ObjectReference{ObjectType: "project", ObjectId: projectID},
		Relation: "org",
		Subject:  &v1.SubjectReference{Object: &v1.ObjectReference{ObjectType: "organization", ObjectId: orgID}},
	}}
}

// orgDefault writes one default-access relation (subject organization#role),
// e.g. the `org_role` default: default_editor@org#member, default_viewer@org#viewer.
func orgDefault(projectID, relation, orgID, orgRole string) *v1.RelationshipUpdate {
	return &v1.RelationshipUpdate{Operation: v1.RelationshipUpdate_OPERATION_TOUCH, Relationship: &v1.Relationship{
		Resource: &v1.ObjectReference{ObjectType: "project", ObjectId: projectID},
		Relation: relation,
		Subject: &v1.SubjectReference{
			Object:           &v1.ObjectReference{ObjectType: "organization", ObjectId: orgID},
			OptionalRelation: orgRole,
		},
	}}
}

func TestClientAgainstSpiceDB(t *testing.T) {
	ctx := context.Background()
	cfg := testutil.SpiceDB(t)
	sdb, err := spicedb.Connect(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sdb.Close() })
	if err := spicedb.ApplySchema(ctx, sdb, schema.Schema, testutil.Logger(t)); err != nil {
		t.Fatal(err)
	}
	vk, err := cache.Connect(ctx, testutil.Valkey(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(vk.Close)
	tokens := authz.NewValkeyTokens(vk)
	c := authz.New(sdb, tokens, authz.Options{CacheTTL: 5 * time.Second}, testutil.Logger(t), nil)

	token, err := c.WriteRelationships(ctx, "acme", []*v1.RelationshipUpdate{
		orgOf("p1", "acme"), orgOf("p2", "acme"),
		orgDefault("p1", "default_editor", "acme", "member"), orgDefault("p1", "default_viewer", "acme", "viewer"),
		orgDefault("p2", "default_editor", "acme", "member"), orgDefault("p2", "default_viewer", "acme", "viewer"),
		rel(v1.RelationshipUpdate_OPERATION_TOUCH, "organization", "acme", "member", "alice"),
		rel(v1.RelationshipUpdate_OPERATION_TOUCH, "organization", "acme", "viewer", "bob"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := tokens.Get(ctx, "acme"); got != token || token == "" {
		t.Fatalf("valkey token = %q, want %q", got, token)
	}

	alice, bob := authz.User("alice"), authz.User("bob")
	p1 := authz.Project("acme", "p1")
	for _, tc := range []struct {
		subj authz.Object
		perm authz.Permission
		res  authz.Resource
		want bool
	}{
		{alice, authz.ProjectEdit, p1, true},
		{alice, authz.ProjectDelete, p1, false},
		{bob, authz.ProjectView, p1, true},
		{bob, authz.ProjectEdit, p1, false},
		{alice, authz.OrgCreateProject, authz.Organization("acme"), true},
		{bob, authz.OrgManage, authz.Organization("acme"), false},
	} {
		got, err := c.Check(ctx, tc.subj, tc.perm, tc.res)
		if err != nil || got != tc.want {
			t.Errorf("Check(%s, %s, %s) = %v, %v; want %v", tc.subj, tc.perm, tc.res.Object, got, err, tc.want)
		}
	}

	res, err := c.CheckBulk(ctx, []authz.CheckItem{
		{Subject: alice, Permission: authz.ProjectManageKeys, Resource: p1},
		{Subject: bob, Permission: authz.ProjectManageKeys, Resource: p1},
		{Subject: bob, Permission: authz.OrgView, Resource: authz.Organization("acme")},
	})
	if err != nil || !slices.Equal(res, []bool{true, false, true}) {
		t.Fatalf("CheckBulk = %v, %v", res, err)
	}

	ids, err := c.LookupResources(ctx, "acme", bob, authz.ProjectView, authz.TypeProject)
	slices.Sort(ids)
	if err != nil || !slices.Equal(ids, []string{"p1", "p2"}) {
		t.Fatalf("LookupResources = %v, %v; want [p1 p2]", ids, err)
	}

	// Revocation is visible to the very next check (read-after-write via
	// the stored ZedToken, cache bypassed by the new token).
	if _, err := c.WriteRelationships(ctx, "acme", []*v1.RelationshipUpdate{
		rel(v1.RelationshipUpdate_OPERATION_DELETE, "organization", "acme", "member", "alice"),
	}); err != nil {
		t.Fatal(err)
	}
	if ok, err := c.Check(ctx, alice, authz.ProjectEdit, p1); ok || err != nil {
		t.Fatalf("after revoke: Check = %v, %v; want false, nil", ok, err)
	}
}

func TestClientFailsClosedWhenSpiceDBUnreachable(t *testing.T) {
	sdb, err := spicedb.Connect(config.AuthzConfig{Endpoint: "127.0.0.1:1", PresharedKey: "x", Insecure: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sdb.Close() })
	c := authz.New(sdb, nil, authz.Options{Timeout: time.Second}, testutil.Logger(t), nil)
	ok, err := c.Check(context.Background(), authz.User("alice"), authz.ProjectView, authz.Project("acme", "p1"))
	if ok || !errors.Is(err, authz.ErrUnavailable) {
		t.Fatalf("Check = %v, %v; want false, ErrUnavailable", ok, err)
	}
}
