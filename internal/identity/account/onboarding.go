package account

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/identity/store/db"
)

// Onboarding answer keys, stored under onboarding.answers.
const (
	AnswerOrgSlug     = "org_slug"
	AnswerProjectSlug = "project_slug"
	AnswerLanguage    = "language"
	AnswerRuntime     = "runtime"
	AnswerMethod      = "method"
	AnswerInvited     = "invited"
)

// MaxInvited bounds the `invited` answer (the number of teammates invited).
const MaxInvited = 1000

// ErrInvalidOnboarding means an onboarding patch has an unknown key or a
// value that is not allowed.
var ErrInvalidOnboarding = errors.New("account: invalid onboarding")

var (
	// StepPattern is the onboarding step rule: a lowercase screen name such
	// as "about", "project" or "install".
	StepPattern = `^[a-z][a-z0-9_-]{0,31}$`
	// SlugPattern is the organization and project slug rule, or empty.
	SlugPattern = `^([a-z0-9][a-z0-9-]{0,62})?$`
	// ChoicePattern is the rule for the language, runtime and method
	// answers (e.g. "python", "fastapi", "sdk"), or empty.
	ChoicePattern = `^([a-z0-9][a-z0-9._+-]{0,31})?$`

	stepRE   = regexp.MustCompile(StepPattern)
	slugRE   = regexp.MustCompile(SlugPattern)
	choiceRE = regexp.MustCompile(ChoicePattern)
)

// OnboardingPatch is a partial update of the onboarding state. Nil fields
// stay unchanged.
type OnboardingPatch struct {
	// Step is the screen to resume at.
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
// and answers only carry the known keys with an allowed value (slugs for
// org_slug and project_slug, short lowercase names for language, runtime
// and method, a count from 0 to MaxInvited for invited).
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
		case AnswerLanguage, AnswerRuntime, AnswerMethod:
			s, isString := v.(string)
			ok = isString && choiceRE.MatchString(s)
		case AnswerInvited:
			ok = validInvited(v)
		default:
			return fmt.Errorf("%w: unknown answer %q", ErrInvalidOnboarding, k)
		}
		if !ok {
			return fmt.Errorf("%w: invalid %s", ErrInvalidOnboarding, k)
		}
	}
	return nil
}

// validInvited accepts a whole number from 0 to MaxInvited, as an int or as
// the float64 encoding/json decodes numbers to.
func validInvited(v any) bool {
	var f float64
	switch n := v.(type) {
	case int:
		f = float64(n)
	case int64:
		f = float64(n)
	case float64:
		f = n
	default:
		return false
	}
	return f >= 0 && f <= MaxInvited && f == math.Trunc(f)
}
