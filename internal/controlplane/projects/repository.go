package projects

import (
	"fmt"
	"net/url"
	"slices"
	"strings"
)

// MaxRepositoryURL bounds a project's repository link, in bytes
// (projects.repository_url allows 1..2048 characters).
const MaxRepositoryURL = 2048

// RepositoryHosts are the hosts a repository link may name unless the
// install allows any host (integrations.allow_any_repository_host). For
// these the commit and release URL templates are known.
var RepositoryHosts = []string{"github.com", "gitlab.com", "bitbucket.org"}

// Placeholders of the URL templates RepositoryTemplates returns. A client
// replaces them with the URL-encoded commit id or release name.
const (
	CommitPlaceholder  = "{commit}"
	ReleasePlaceholder = "{release}"
)

// RepositoryURLError is why NormalizeRepositoryURL rejected a link. It is
// ErrInvalid (errors.Is), and Reason is a sentence the API answers as the
// problem's detail so a client can show it next to the field.
type RepositoryURLError struct {
	Reason string
}

func (e *RepositoryURLError) Error() string {
	return ErrInvalid.Error() + ": repository url: " + e.Reason
}

// Unwrap makes a RepositoryURLError match ErrInvalid.
func (e *RepositoryURLError) Unwrap() error { return ErrInvalid }

// NormalizeRepositoryURL checks a repository link and returns it in its
// canonical form: https only, no credentials, query or fragment, a lower-case
// host from RepositoryHosts (any host when anyHost; a port only then), and a
// path naming the repository (owner/name on the known hosts) without a
// trailing slash or ".git". Surrounding spaces are trimmed; an empty link is
// returned as "" (no repository). Anything else is a *RepositoryURLError
// (ErrInvalid).
func NormalizeRepositoryURL(raw string, anyHost bool) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", nil
	}
	invalid := func(why string) error { return &RepositoryURLError{Reason: why} }
	tooLong := fmt.Sprintf("The repository link must be at most %d characters.", MaxRepositoryURL)
	if len(s) > MaxRepositoryURL {
		return "", invalid(tooLong)
	}
	u, err := url.Parse(s)
	if err != nil {
		return "", invalid("The repository link is not a URL.")
	}
	if !strings.EqualFold(u.Scheme, "https") || u.Opaque != "" {
		return "", invalid("The repository link must start with https://.")
	}
	if u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return "", invalid("The repository link must not carry credentials, a query or a fragment.")
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return "", invalid("The repository link has no host.")
	}
	known := slices.Contains(RepositoryHosts, host)
	if !anyHost && (!known || u.Port() != "") {
		return "", invalid("The repository must be on github.com, gitlab.com or bitbucket.org.")
	}
	path := strings.TrimRight(u.EscapedPath(), "/")
	path = strings.TrimRight(strings.TrimSuffix(path, ".git"), "/")
	segments := 0
	for _, seg := range strings.Split(path, "/") {
		if seg != "" {
			segments++
		}
	}
	if segments == 0 || (known && segments < 2) || strings.Contains(path, "//") {
		return "", invalid("The repository link must name a repository, like https://github.com/acme/shop.")
	}
	out := "https://" + strings.ToLower(u.Host) + path
	if len(out) > MaxRepositoryURL {
		return "", invalid(tooLong)
	}
	return out, nil
}

// RepositoryTemplates derives the commit and release URL templates of a
// normalized repository link, with CommitPlaceholder and ReleasePlaceholder
// in them. Both are nil when the link is nil or names a host whose URL
// layout is not known (any host beyond RepositoryHosts).
func RepositoryTemplates(repo *string) (commit, release *string) {
	if repo == nil || *repo == "" {
		return nil, nil
	}
	u, err := url.Parse(*repo)
	if err != nil {
		return nil, nil
	}
	var c, r string
	switch u.Host {
	case "github.com":
		c, r = "/commit/", "/releases/tag/"
	case "gitlab.com":
		c, r = "/-/commit/", "/-/releases/"
	case "bitbucket.org":
		c, r = "/commits/", "/src/"
	default:
		return nil, nil
	}
	c, r = *repo+c+CommitPlaceholder, *repo+r+ReleasePlaceholder
	return &c, &r
}
