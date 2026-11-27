package users

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/apilens/apilens/internal/identity/account"
)

func TestSourceValid(t *testing.T) {
	for _, s := range []Source{SourceEmail, SourceGoogle, SourceGitHub, SourceSSO, SourceOperator} {
		if !s.Valid() {
			t.Errorf("%q not valid", s)
		}
	}
	for _, s := range []Source{"", "password", "Email"} {
		if s.Valid() {
			t.Errorf("%q valid", s)
		}
	}
}

func TestFindOrCreateRejectsUnknownSource(t *testing.T) {
	// The source is checked before the database is touched.
	_, _, err := (&Service{}).FindOrCreateByVerifiedEmail(context.Background(), "ada@example.com", "password")
	if !errors.Is(err, ErrInvalidSource) {
		t.Fatalf("err = %v, want ErrInvalidSource", err)
	}
}

func TestDefaults(t *testing.T) {
	prefs := DefaultPreferences()
	if len(prefs) != 1 || prefs["home"] != "endpoints" {
		t.Fatalf("preferences = %v, want {home: endpoints}", prefs)
	}
	if err := account.ValidatePreferences(prefs); err != nil {
		t.Fatalf("default preferences invalid: %v", err)
	}
	if ob := DefaultOnboarding(); len(ob) != 1 || ob["step"] != OnboardingStepWelcome {
		t.Fatalf("onboarding = %v, want {step: welcome}", ob)
	}
	if OnboardingPath != "/onboarding/welcome" {
		t.Fatalf("OnboardingPath = %q", OnboardingPath)
	}
	// Each call returns a fresh map, so a caller cannot change the defaults.
	DefaultPreferences()["home"] = "requests"
	if DefaultPreferences()["home"] != "endpoints" {
		t.Fatal("defaults shared between calls")
	}
}

// createUserCall matches a call of a query that inserts users.
var createUserCall = regexp.MustCompile(`\.(CreateUser|CreateFirstLoginUser)\(`)

// TestOnlyThisPackageCreatesUsers is the guard that every sign-in method
// (email code and link, Google, GitHub, SSO) ends in
// FindOrCreateByVerifiedEmail: no production code outside this package and
// the generated queries calls a query that inserts a user.
func TestOnlyThisPackageCreatesUsers(t *testing.T) {
	root := repoRoot(t)
	allowed := []string{
		filepath.Join(root, "internal", "identity", "users") + string(filepath.Separator),
		filepath.Join(root, "internal", "identity", "store", "db") + string(filepath.Separator),
	}
	var offenders []string
	for _, dir := range []string{"internal", "cmd"} {
		err := filepath.WalkDir(filepath.Join(root, dir), func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			for _, a := range allowed {
				if strings.HasPrefix(path, a) {
					return nil
				}
			}
			src, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			if createUserCall.Match(src) {
				rel, _ := filepath.Rel(root, path)
				offenders = append(offenders, rel)
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	if len(offenders) > 0 {
		t.Fatalf("users are created outside users.FindOrCreateByVerifiedEmail in %v; "+
			"every sign-in method must call it instead", offenders)
	}
}

// repoRoot walks up from the package directory to the directory with go.mod.
func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("go.mod not found")
		}
		dir = parent
	}
}

func TestProfileName(t *testing.T) {
	for _, c := range []struct {
		in   map[string]any
		want string
	}{
		{map[string]any{"name": "  Ada Lovelace "}, "Ada Lovelace"},
		{map[string]any{"name": "   "}, ""},
		{map[string]any{"name": strings.Repeat("é", 101)}, ""},
		{map[string]any{"name": 42}, ""},
		{nil, ""},
	} {
		if got := ProfileName(c.in); got != c.want {
			t.Errorf("ProfileName(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestCleanName(t *testing.T) {
	for in, want := range map[string]string{
		"  Ada Lovelace ":        "Ada Lovelace",
		"   ":                    "",
		strings.Repeat("é", 100): strings.Repeat("é", 100),
		strings.Repeat("é", 101): "",
	} {
		if got := CleanName(in); got != want {
			t.Errorf("CleanName(%q) = %q, want %q", in, got, want)
		}
	}
}
