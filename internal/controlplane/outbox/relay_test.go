package outbox

import (
	"encoding/json"
	"errors"
	"slices"
	"testing"
	"time"

	v1 "github.com/authzed/authzed-go/proto/authzed/api/v1"
	"github.com/google/uuid"
)

// describe renders updates as "OP type:id#rel@type:id" for comparison.
func describe(updates []*v1.RelationshipUpdate) []string {
	out := make([]string, len(updates))
	for i, u := range updates {
		op := "TOUCH"
		if u.GetOperation() == v1.RelationshipUpdate_OPERATION_DELETE {
			op = "DELETE"
		}
		r := u.GetRelationship()
		out[i] = op + " " + r.GetResource().GetObjectType() + ":" + r.GetResource().GetObjectId() + "#" + r.GetRelation() +
			"@" + r.GetSubject().GetObject().GetObjectType() + ":" + r.GetSubject().GetObject().GetObjectId()
	}
	return out
}

func TestTranslateEveryTopic(t *testing.T) {
	org, user, proj, other := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	o, u, p, o2 := org.String(), user.String(), proj.String(), other.String()
	cases := []struct {
		payload Payload
		updates []string
		delete  string // "type:id" of the filter, "" for none
		orgs    []string
	}{
		{OrgCreatedPayload{OrgID: org, OwnerUserID: user}, []string{"TOUCH organization:" + o + "#owner@user:" + u}, "", []string{o}},
		{OrgDeletedPayload{OrgID: org}, nil, "organization:" + o, []string{o}},
		{MembershipUpsertedPayload{OrgID: org, UserID: user, Role: "member"}, []string{
			"DELETE organization:" + o + "#owner@user:" + u,
			"DELETE organization:" + o + "#admin@user:" + u,
			"DELETE organization:" + o + "#viewer@user:" + u,
			"TOUCH organization:" + o + "#member@user:" + u,
		}, "", []string{o}},
		{MembershipDeletedPayload{OrgID: org, UserID: user}, []string{
			"DELETE organization:" + o + "#owner@user:" + u,
			"DELETE organization:" + o + "#admin@user:" + u,
			"DELETE organization:" + o + "#member@user:" + u,
			"DELETE organization:" + o + "#viewer@user:" + u,
		}, "", []string{o}},
		{ProjectCreatedPayload{ProjectID: proj, OrgID: org}, []string{"TOUCH project:" + p + "#org@organization:" + o}, "", []string{o}},
		{ProjectDeletedPayload{ProjectID: proj}, nil, "project:" + p, nil},
		{ProjectMovedPayload{ProjectID: proj, FromOrgID: org, ToOrgID: other}, []string{
			"DELETE project:" + p + "#org@organization:" + o,
			"TOUCH project:" + p + "#org@organization:" + o2,
		}, "", []string{o, o2}},
	}
	if len(cases) != len(Topics) {
		t.Fatalf("%d cases for %d topics", len(cases), len(Topics))
	}
	for _, c := range cases {
		raw, err := json.Marshal(c.payload)
		if err != nil {
			t.Fatal(err)
		}
		got, err := Translate(c.payload.topic(), raw)
		if err != nil {
			t.Fatalf("%s: %v", c.payload.topic(), err)
		}
		if d := describe(got.Updates); !slices.Equal(d, c.updates) {
			t.Errorf("%s updates:\n got %q\nwant %q", c.payload.topic(), d, c.updates)
		}
		var del string
		if f := got.Delete; f != nil {
			del = f.GetResourceType() + ":" + f.GetOptionalResourceId()
			if f.GetOptionalRelation() != "" || f.GetOptionalSubjectFilter() != nil {
				t.Errorf("%s: delete filter narrower than the whole resource: %v", c.payload.topic(), f)
			}
		}
		if del != c.delete {
			t.Errorf("%s delete = %q, want %q", c.payload.topic(), del, c.delete)
		}
		if !slices.Equal(got.Orgs, c.orgs) {
			t.Errorf("%s orgs = %v, want %v", c.payload.topic(), got.Orgs, c.orgs)
		}
	}
}

func TestTranslateEveryRoleTouchesOnlyThatRole(t *testing.T) {
	org, user := uuid.New(), uuid.New()
	for _, role := range orgRoles {
		raw, _ := json.Marshal(MembershipUpsertedPayload{OrgID: org, UserID: user, Role: role})
		c, err := Translate(MembershipUpserted, raw)
		if err != nil {
			t.Fatal(err)
		}
		var touched []string
		for _, u := range c.Updates {
			if u.GetOperation() == v1.RelationshipUpdate_OPERATION_TOUCH {
				touched = append(touched, u.GetRelationship().GetRelation())
			}
		}
		if len(c.Updates) != len(orgRoles) || !slices.Equal(touched, []string{role}) {
			t.Errorf("role %s: %q", role, describe(c.Updates))
		}
	}
}

func TestTranslateRejects(t *testing.T) {
	org, user := uuid.New(), uuid.New()
	badRole, _ := json.Marshal(MembershipUpsertedPayload{OrgID: org, UserID: user, Role: "superuser"})
	for _, c := range []struct {
		name    string
		topic   Topic
		payload []byte
		want    error
	}{
		{"unknown topic", Topic("team.created"), []byte(`{}`), ErrUnknownTopic},
		{"bad json", OrgCreated, []byte(`{`), ErrInvalid},
		{"unknown role", MembershipUpserted, badRole, ErrInvalid},
	} {
		if _, err := Translate(c.topic, c.payload); !errors.Is(err, c.want) {
			t.Errorf("%s: err = %v, want %v", c.name, err, c.want)
		}
	}
}

func TestProjectMovedWithinTheSameOrgOnlyTouches(t *testing.T) {
	org, proj := uuid.New(), uuid.New()
	raw, _ := json.Marshal(ProjectMovedPayload{ProjectID: proj, FromOrgID: org, ToOrgID: org})
	c, err := Translate(ProjectMoved, raw)
	if err != nil {
		t.Fatal(err)
	}
	if d := describe(c.Updates); len(d) != 1 || d[0] != "TOUCH project:"+proj.String()+"#org@organization:"+org.String() {
		t.Fatalf("updates = %q", d)
	}
}

func TestProjectDeletedReadsItsOrgForTheZedToken(t *testing.T) {
	proj := uuid.New()
	raw, _ := json.Marshal(ProjectDeletedPayload{ProjectID: proj})
	c, err := Translate(ProjectDeleted, raw)
	if err != nil {
		t.Fatal(err)
	}
	f := c.OrgsFrom
	if f.GetResourceType() != "project" || f.GetOptionalResourceId() != proj.String() || f.GetOptionalRelation() != "org" {
		t.Fatalf("OrgsFrom = %v", f)
	}
}

func TestRetryBackoff(t *testing.T) {
	want := []time.Duration{time.Second, time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second, 30 * time.Second, 30 * time.Second}
	for attempt, w := range want {
		if got := RetryBackoff(attempt); got != w {
			t.Errorf("RetryBackoff(%d) = %v, want %v", attempt, got, w)
		}
	}
	if got := RetryBackoff(100); got != 30*time.Second {
		t.Errorf("RetryBackoff(100) = %v", got)
	}
}
