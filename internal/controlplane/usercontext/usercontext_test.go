package usercontext

import (
	"slices"
	"testing"
)

// TestActions mirrors the role → action table of authz/README.md for
// organization roles.
func TestActions(t *testing.T) {
	for role, want := range map[string][]string{
		"owner": {
			ActionProjectRead, ActionProjectUpdate, ActionProjectDelete, ActionAPIKeysCreate, ActionAPIKeysRevoke,
			ActionMembersInvite, ActionMembersRemove, ActionBillingManage,
		},
		"admin": {
			ActionProjectRead, ActionProjectUpdate, ActionProjectDelete, ActionAPIKeysCreate, ActionAPIKeysRevoke,
			ActionMembersInvite, ActionMembersRemove,
		},
		"member":    {ActionProjectRead, ActionProjectUpdate, ActionAPIKeysCreate, ActionAPIKeysRevoke},
		"viewer":    {ActionProjectRead},
		"":          {},
		"superuser": {},
	} {
		if got := Actions(role); !slices.Equal(got, want) || got == nil {
			t.Errorf("Actions(%q) = %v, want %v", role, got, want)
		}
	}
}

func TestLastProject(t *testing.T) {
	for raw, want := range map[string]string{
		`{"last_project_slug":"checkout","home":"requests"}`: "checkout",
		`{"home":"requests"}`:                                "",
		`{"last_project_slug":7}`:                            "",
		`not json`:                                           "",
		``:                                                   "",
	} {
		if got := lastProject([]byte(raw)); got != want {
			t.Errorf("lastProject(%s) = %q, want %q", raw, got, want)
		}
	}
}
