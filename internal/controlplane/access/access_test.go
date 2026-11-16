package access

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/controlplane/store/db"
)

func TestCursorRoundTrip(t *testing.T) {
	id := uuid.New()
	email, got, err := decodeCursor(encodeCursor("a:b@example.com", id))
	if err != nil || email != "a:b@example.com" || got != id {
		t.Fatalf("decode = %q %v %v", email, got, err)
	}
	for _, bad := range []string{"%%%", "c2hvcnQ", encodeCursor("", id)[:10]} {
		if _, _, err := decodeCursor(bad); err == nil {
			t.Errorf("decodeCursor(%q) accepted", bad)
		}
	}
}

func TestListRejectsBadFilters(t *testing.T) {
	s := New(nil) // never reaches the database
	for _, f := range []Filter{{Role: "owner"}, {Source: "team"}, {Cursor: "not-a-cursor!"}} {
		if _, err := s.List(context.Background(), uuid.New(), f); !errors.Is(err, ErrInvalid) {
			t.Errorf("List(%+v) = %v, want ErrInvalid", f, err)
		}
	}
}

func TestToPerson(t *testing.T) {
	joined := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	granted := joined.Add(time.Hour)
	admin, by, byEmail := "admin", uuid.New(), "lead@example.com"
	p := toPerson(db.ListProjectAccessRow{
		UserID: uuid.New(), OrgRole: "member", JoinedAt: joined, Email: "ada@example.com",
		DirectRole: &admin, AddedBy: &by, GrantedAt: &granted, AddedByEmail: &byEmail, AddedByName: new(string),
		DefaultRank: 2, DirectRank: 3, EffectiveRank: 3,
	})
	want := []Source{{Kind: SourceDefault, Role: RoleEditor, OrgRole: "member"}, {Kind: SourceDirect, Role: RoleAdmin}}
	if p.EffectiveRole != RoleAdmin || !slices.Equal(p.Sources, want) || p.Initials != "A" || !p.AddedAt.Equal(granted) ||
		p.AddedBy == nil || p.AddedBy.Name != byEmail {
		t.Fatalf("person = %+v", p)
	}

	owner := toPerson(db.ListProjectAccessRow{UserID: uuid.New(), OrgRole: "owner", JoinedAt: joined, Name: "Grace Hopper", OrgRank: 3, EffectiveRank: 3})
	if owner.EffectiveRole != RoleAdmin || !slices.Equal(owner.Sources, []Source{{Kind: SourceOrgRole, Role: RoleAdmin, OrgRole: "owner"}}) ||
		owner.Initials != "GH" || owner.AddedBy != nil || !owner.AddedAt.Equal(joined) {
		t.Fatalf("owner = %+v", owner)
	}
}
