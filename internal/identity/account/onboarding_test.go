package account

import (
	"errors"
	"testing"
)

func TestValidateOnboarding(t *testing.T) {
	str := func(s string) *string { return &s }
	for _, ok := range []OnboardingPatch{
		{},
		{Step: str("about")},
		{Step: str("first_requests")},
		{Answers: map[string]any{
			AnswerOrgSlug: "acme", AnswerProjectSlug: "checkout-2", AnswerLanguage: "python",
			AnswerRuntime: "node.js", AnswerMethod: "otel", AnswerInvited: 3,
		}},
		{Answers: map[string]any{AnswerOrgSlug: "", AnswerInvited: float64(0)}},
		{Answers: map[string]any{AnswerInvited: float64(MaxInvited)}},
	} {
		if err := ValidateOnboarding(ok); err != nil {
			t.Errorf("ValidateOnboarding(%+v) = %v", ok, err)
		}
	}
	for name, bad := range map[string]OnboardingPatch{
		"empty step":       {Step: str("")},
		"upper step":       {Step: str("About")},
		"long step":        {Step: str("a234567890123456789012345678901234")},
		"unknown answer":   {Answers: map[string]any{"email": "x@example.com"}},
		"bad slug":         {Answers: map[string]any{AnswerOrgSlug: "Acme"}},
		"slug not string":  {Answers: map[string]any{AnswerProjectSlug: 7}},
		"bad language":     {Answers: map[string]any{AnswerLanguage: "py thon"}},
		"invited negative": {Answers: map[string]any{AnswerInvited: -1}},
		"invited fraction": {Answers: map[string]any{AnswerInvited: 1.5}},
		"invited too many": {Answers: map[string]any{AnswerInvited: MaxInvited + 1}},
		"invited string":   {Answers: map[string]any{AnswerInvited: "3"}},
	} {
		if err := ValidateOnboarding(bad); !errors.Is(err, ErrInvalidOnboarding) {
			t.Errorf("%s: err = %v", name, err)
		}
	}
}
