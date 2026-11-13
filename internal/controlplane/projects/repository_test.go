package projects

import (
	"errors"
	"strings"
	"testing"
)

func TestNormalizeRepositoryURL(t *testing.T) {
	long := "https://github.com/acme/" + strings.Repeat("a", MaxRepositoryURL)
	for _, tc := range []struct {
		name    string
		in      string
		anyHost bool
		want    string
		invalid bool
	}{
		{name: "empty clears", in: "  ", want: ""},
		{name: "github", in: "https://github.com/acme/shop", want: "https://github.com/acme/shop"},
		{name: "trimmed, trailing slash and .git dropped", in: " https://GitHub.com/acme/shop.git/ ", want: "https://github.com/acme/shop"},
		{name: "gitlab subgroup", in: "https://gitlab.com/acme/platform/shop", want: "https://gitlab.com/acme/platform/shop"},
		{name: "bitbucket", in: "https://bitbucket.org/acme/shop", want: "https://bitbucket.org/acme/shop"},
		{name: "upper-case scheme", in: "HTTPS://github.com/acme/shop", want: "https://github.com/acme/shop"},

		// Scheme.
		{name: "http", in: "http://github.com/acme/shop", invalid: true},
		{name: "ssh", in: "ssh://git@github.com/acme/shop", invalid: true},
		{name: "scp-style", in: "git@github.com:acme/shop.git", invalid: true},
		{name: "javascript", in: "javascript:alert(1)", invalid: true},
		{name: "no scheme", in: "github.com/acme/shop", invalid: true},

		// Host.
		{name: "other host", in: "https://git.example.com/acme/shop", invalid: true},
		{name: "lookalike host", in: "https://github.com.example.com/acme/shop", invalid: true},
		{name: "subdomain", in: "https://www.github.com/acme/shop", invalid: true},
		{name: "port on known host", in: "https://github.com:8443/acme/shop", invalid: true},
		{name: "credentials", in: "https://token@github.com/acme/shop", invalid: true},
		{name: "no host", in: "https:///acme/shop", invalid: true},
		{name: "any host allowed", in: "https://git.example.com:8443/acme/shop", anyHost: true, want: "https://git.example.com:8443/acme/shop"},
		{name: "any host still https", in: "http://git.example.com/acme/shop", anyHost: true, invalid: true},

		// Path, query, fragment.
		{name: "owner only", in: "https://github.com/acme", invalid: true},
		{name: "no path", in: "https://github.com", invalid: true},
		{name: "query", in: "https://github.com/acme/shop?tab=readme", invalid: true},
		{name: "fragment", in: "https://github.com/acme/shop#readme", invalid: true},
		{name: "empty segment", in: "https://github.com/acme//shop", invalid: true},

		// Length.
		{name: "too long", in: long, invalid: true},
	} {
		got, err := NormalizeRepositoryURL(tc.in, tc.anyHost)
		if tc.invalid {
			if !errors.Is(err, ErrInvalid) {
				t.Errorf("%s: NormalizeRepositoryURL(%q) = %q, %v; want ErrInvalid", tc.name, tc.in, got, err)
			}
			continue
		}
		if err != nil || got != tc.want {
			t.Errorf("%s: NormalizeRepositoryURL(%q) = %q, %v; want %q", tc.name, tc.in, got, err, tc.want)
		}
	}

	// The limit is inclusive.
	at := "https://github.com/acme/"
	at += strings.Repeat("a", MaxRepositoryURL-len(at))
	if got, err := NormalizeRepositoryURL(at, false); err != nil || got != at {
		t.Errorf("%d-byte url: %q, %v", MaxRepositoryURL, got, err)
	}
}

func TestRepositoryTemplates(t *testing.T) {
	str := func(s string) *string { return &s }
	for _, tc := range []struct {
		repo            *string
		commit, release string
		none            bool
	}{
		{repo: str("https://github.com/acme/shop"), commit: "https://github.com/acme/shop/commit/{commit}", release: "https://github.com/acme/shop/releases/tag/{release}"},
		{repo: str("https://gitlab.com/acme/platform/shop"), commit: "https://gitlab.com/acme/platform/shop/-/commit/{commit}", release: "https://gitlab.com/acme/platform/shop/-/releases/{release}"},
		{repo: str("https://bitbucket.org/acme/shop"), commit: "https://bitbucket.org/acme/shop/commits/{commit}", release: "https://bitbucket.org/acme/shop/src/{release}"},
		{repo: str("https://git.example.com/acme/shop"), none: true},
		{repo: nil, none: true},
	} {
		c, r := RepositoryTemplates(tc.repo)
		if tc.none {
			if c != nil || r != nil {
				t.Errorf("RepositoryTemplates(%v) = %v, %v; want nil", tc.repo, c, r)
			}
			continue
		}
		if c == nil || r == nil || *c != tc.commit || *r != tc.release {
			t.Errorf("RepositoryTemplates(%q) = %v, %v", *tc.repo, c, r)
		}
	}
}
