package identity

import (
	"testing"
	"time"
)

func TestNewOnboardingState(t *testing.T) {
	at := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	for raw, check := range map[string]func(Onboarding) bool{
		`{}`:               func(o Onboarding) bool { return o.Step == nil && !o.Completed && o.CompletedAt == nil },
		`not json`:         func(o Onboarding) bool { return o.Step == nil && !o.Completed },
		`{"step":"about"}`: func(o Onboarding) bool { return o.Step != nil && *o.Step == "about" && !o.Completed },
		`{"step":7}`:       func(o Onboarding) bool { return o.Step == nil },
		`{"completed":true}`: func(o Onboarding) bool {
			return o.Completed && o.CompletedAt == nil
		},
		`{"completed_at":"2026-11-04T12:00:00+00:00"}`: func(o Onboarding) bool {
			return o.Completed && o.CompletedAt != nil && o.CompletedAt.Equal(at)
		},
		`{"answers":{"org_slug":"acme","language":"go","invited":2,"runtime":3}}`: func(o Onboarding) bool {
			a := o.Answers
			return a.OrgSlug != nil && *a.OrgSlug == "acme" && a.Language != nil && *a.Language == "go" &&
				a.Invited != nil && *a.Invited == 2 && a.Runtime == nil && a.ProjectSlug == nil
		},
		`{"answers":{"invited":-1}}`: func(o Onboarding) bool { return o.Answers.Invited == nil },
		`{"answers":"acme"}`:         func(o Onboarding) bool { return o.Answers.OrgSlug == nil },
	} {
		if got := NewOnboardingState([]byte(raw)); !check(got) {
			t.Errorf("NewOnboardingState(%s) = %+v", raw, got)
		}
	}
}
