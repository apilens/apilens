package orgs

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestNormalizeInviteEmail(t *testing.T) {
	for in, want := range map[string]string{
		"ada@example.com":     "ada@example.com",
		"  Ada@Example.com  ": "Ada@Example.com",
	} {
		if got, ok := NormalizeInviteEmail(in); !ok || got != want {
			t.Errorf("%q = %q, %v; want %q", in, got, ok, want)
		}
	}
	for _, in := range []string{
		"", "   ", "ada", "ada@", "Ada <ada@example.com>", "ada@example.com, bob@example.com",
		strings.Repeat("a", 310) + "@example.com",
	} {
		if got, ok := NormalizeInviteEmail(in); ok {
			t.Errorf("%q accepted as %q", in, got)
		}
	}
}

func TestInviteValidatesBeforeTouchingTheDatabase(t *testing.T) {
	// A nil pool would panic if Invite reached the database.
	s := NewInvitations(nil, nil, nil)
	ok := Invite{Email: "a@example.com", Role: RoleMember}
	many := make([]Invite, MaxInvites+1)
	for i := range many {
		many[i] = ok
	}
	for name, in := range map[string][]Invite{
		"none":      nil,
		"too many":  many,
		"owner":     {{Email: "a@example.com", Role: RoleOwner}},
		"bad role":  {{Email: "a@example.com", Role: "superuser"}},
		"bad email": {ok, {Email: "nope", Role: RoleMember}},
	} {
		if _, err := s.Invite(context.Background(), uuid.New(), "acme", in, nil); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: %v, want ErrInvalid", name, err)
		}
	}
	project := uuid.New()
	tooMany := make([]ProjectGrant, MaxProjectGrants+1)
	for i := range tooMany {
		tooMany[i] = ProjectGrant{ProjectID: uuid.New(), Role: "viewer"}
	}
	for name, grants := range map[string][]ProjectGrant{
		"too many grants":     tooMany,
		"org role":            {{ProjectID: project, Role: RoleMember}},
		"unknown role":        {{ProjectID: project, Role: "owner"}},
		"project named twice": {{ProjectID: project, Role: "viewer"}, {ProjectID: project, Role: "admin"}},
	} {
		if _, err := s.Invite(context.Background(), uuid.New(), "acme", []Invite{ok}, grants); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: %v, want ErrInvalid", name, err)
		}
	}
}

func TestInvitationToken(t *testing.T) {
	raw, hash, err := newInvitationToken()
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) != 43 || hash != HashInvitationToken(raw) || len(hash) != 64 {
		t.Fatalf("raw %q hash %q", raw, hash)
	}
	if raw2, _, _ := newInvitationToken(); raw2 == raw {
		t.Fatal("tokens repeat")
	}
}

func TestMaskEmail(t *testing.T) {
	for in, want := range map[string]string{
		"ada@example.com":     "a***@example.com",
		"a@example.com":       "a***@example.com",
		"Émile.Z@Example.COM": "É***@Example.COM",
		"no-at-sign":          "***",
		"@example.com":        "***",
	} {
		if got := MaskEmail(in); got != want {
			t.Errorf("MaskEmail(%q) = %q, want %q", in, got, want)
		}
	}
}
