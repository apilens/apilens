package account

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/identity/store/db"
)

// Onboarding answer keys, stored under onboarding.answers.
const (
	AnswerOrgSlug     = "org_slug"
	AnswerProjectSlug = "project_slug"
)

// ErrInvalidOnboarding means an onboarding patch has an unknown key or a
// value that is not allowed.
var ErrInvalidOnboarding = errors.New("account: invalid onboarding")

var (
	// StepPattern is the onboarding step rule: a lowercase screen name such
	// as "welcome" or "done".
	StepPattern = `^[a-z][a-z0-9_-]{0,31}$`
	// SlugPattern is the organization and project slug rule, or empty.
	SlugPattern = `^([a-z0-9][a-z0-9-]{0,62})?$`

	stepRE = regexp.MustCompile(StepPattern)
	slugRE = regexp.MustCompile(SlugPattern)
)

// OnboardingPatch is a partial update of the onboarding state. Nil fields
// stay unchanged.
type OnboardingPatch struct {
	// Step is the stored step: "welcome" or "done".
	Step *string
	// Answers is merged key by key into the stored answers.
	Answers map[string]any
	// Completed true finishes onboarding (completed_at is stamped once);
	// false reopens it.
	Completed *bool
}

// UpdateOnboarding merges p into user id's onboarding state in one
// statement, so concurrent patches never lose each other's answers.
func (s *Service) UpdateOnboarding(ctx context.Context, id uuid.UUID, p OnboardingPatch) (db.User, error) {
	if err := ValidateOnboarding(p); err != nil {
		return db.User{}, err
	}
	top := map[string]any{}
	if p.Step != nil {
		top["step"] = *p.Step
	}
	answers := p.Answers
	if answers == nil {
		answers = map[string]any{}
	}
	topJSON, err := json.Marshal(top)
	if err != nil {
		return db.User{}, fmt.Errorf("account: encode onboarding: %w", err)
	}
	answersJSON, err := json.Marshal(answers)
	if err != nil {
		return db.User{}, fmt.Errorf("account: encode answers: %w", err)
	}
	u, err := s.q.MergeUserOnboarding(ctx, db.MergeUserOnboardingParams{
		ID: id, Patch: topJSON, Answers: answersJSON, Completed: p.Completed,
	})
	if err != nil {
		return db.User{}, notFound(err, "update onboarding")
	}
	return u, nil
}

// ValidateOnboarding checks an onboarding patch: the step is a screen name,
// and answers only carry the known keys (org_slug, project_slug) with a
// slug value.
func ValidateOnboarding(p OnboardingPatch) error {
	if p.Step != nil && !stepRE.MatchString(*p.Step) {
		return fmt.Errorf("%w: step must match %s", ErrInvalidOnboarding, StepPattern)
	}
	for k, v := range p.Answers {
		var ok bool
		switch k {
		case AnswerOrgSlug, AnswerProjectSlug:
			s, isString := v.(string)
			ok = isString && slugRE.MatchString(s)
		default:
			return fmt.Errorf("%w: unknown answer %q", ErrInvalidOnboarding, k)
		}
		if !ok {
			return fmt.Errorf("%w: invalid %s", ErrInvalidOnboarding, k)
		}
	}
	return nil
}
