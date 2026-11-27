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
			AnswerOrgSlug: "acme", AnswerProjectSlug: "checkout-2",
		}},
		{Answers: map[string]any{AnswerOrgSlug: ""}},
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
		"removed language": {Answers: map[string]any{"language": "python"}},
		"removed invited":  {Answers: map[string]any{"invited": 3}},
		"removed key id":   {Answers: map[string]any{"api_key_id": "0b6f5c7e-8d1a-4c2b-9e3f-1a2b3c4d5e6f"}},
	} {
		if err := ValidateOnboarding(bad); !errors.Is(err, ErrInvalidOnboarding) {
			t.Errorf("%s: err = %v", name, err)
		}
	}
}
