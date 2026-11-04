package outbox

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/google/uuid"
)

func TestPayloadJSONMatchesDocumentedContract(t *testing.T) {
	org, user, proj, other := uuid.New(), uuid.New(), uuid.New(), uuid.New()
	cases := []struct {
		payload Payload
		topic   Topic
		agg     uuid.UUID
		keys    []string
	}{
		{OrgCreatedPayload{OrgID: org, OwnerUserID: user}, OrgCreated, org, []string{"org_id", "owner_user_id"}},
		{OrgDeletedPayload{OrgID: org}, OrgDeleted, org, []string{"org_id"}},
		{MembershipUpsertedPayload{OrgID: org, UserID: user, Role: "admin"}, MembershipUpserted, org, []string{"org_id", "user_id", "role"}},
		{MembershipDeletedPayload{OrgID: org, UserID: user}, MembershipDeleted, org, []string{"org_id", "user_id"}},
		{ProjectCreatedPayload{ProjectID: proj, OrgID: org}, ProjectCreated, proj, []string{"project_id", "org_id"}},
		{ProjectDeletedPayload{ProjectID: proj}, ProjectDeleted, proj, []string{"project_id"}},
		{ProjectMovedPayload{ProjectID: proj, FromOrgID: org, ToOrgID: other}, ProjectMoved, proj, []string{"project_id", "from_org_id", "to_org_id"}},
	}
	if len(cases) != len(Topics) {
		t.Fatalf("%d cases for %d topics", len(cases), len(Topics))
	}
	for i, c := range cases {
		if Topics[i] != c.topic || c.payload.topic() != c.topic {
			t.Errorf("case %d: topic %s, payload topic %s, Topics[%d] %s", i, c.topic, c.payload.topic(), i, Topics[i])
		}
		if err := validate(c.topic, c.agg, c.payload); err != nil {
			t.Errorf("%s: %v", c.topic, err)
		}
		raw, err := json.Marshal(c.payload)
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]string
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatalf("%s: %s: %v", c.topic, raw, err)
		}
		if len(m) != len(c.keys) {
			t.Errorf("%s: %s, want keys %v", c.topic, raw, c.keys)
		}
		for _, k := range c.keys {
			if _, ok := m[k]; !ok {
				t.Errorf("%s: %s lacks %q", c.topic, raw, k)
			}
		}
	}
}

func TestEmitRejectsMismatchedEventsBeforeTouchingTheTx(t *testing.T) {
	org, user := uuid.New(), uuid.New()
	cases := map[string]struct {
		topic   Topic
		agg     uuid.UUID
		payload Payload
	}{
		"wrong topic":     {OrgDeleted, org, OrgCreatedPayload{OrgID: org, OwnerUserID: user}},
		"unknown topic":   {Topic("org.renamed"), org, OrgDeletedPayload{OrgID: org}},
		"nil payload":     {OrgDeleted, org, nil},
		"nil aggregate":   {OrgDeleted, uuid.Nil, OrgDeletedPayload{}},
		"other aggregate": {MembershipDeleted, user, MembershipDeletedPayload{OrgID: org, UserID: user}},
	}
	for name, c := range cases {
		// A nil tx proves validation runs first: touching it would panic.
		if err := Emit(context.Background(), nil, c.topic, c.agg, c.payload); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: err = %v, want ErrInvalid", name, err)
		}
	}
}
