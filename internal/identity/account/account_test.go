package account

import (
	"errors"
	"testing"
)

func TestValidatePreferences(t *testing.T) {
	for _, home := range Homes {
		if err := ValidatePreferences(map[string]any{"home": home}); err != nil {
			t.Errorf("home %q: %v", home, err)
		}
	}
	if err := ValidatePreferences(nil); err != nil {
		t.Errorf("nil: %v", err)
	}
	for _, bad := range []any{"dashboard", "", 1, nil} {
		if err := ValidatePreferences(map[string]any{"home": bad}); !errors.Is(err, ErrInvalidPreference) {
			t.Errorf("home %v: err = %v", bad, err)
		}
	}
	for _, slug := range []string{"checkout", "a", "web-2", ""} {
		if err := ValidatePreferences(map[string]any{"last_project_slug": slug}); err != nil {
			t.Errorf("last_project_slug %q: %v", slug, err)
		}
	}
	for _, bad := range []any{"Checkout", "-web", "a b", 1, nil} {
		if err := ValidatePreferences(map[string]any{"last_project_slug": bad}); !errors.Is(err, ErrInvalidPreference) {
			t.Errorf("last_project_slug %v: err = %v", bad, err)
		}
	}
}
