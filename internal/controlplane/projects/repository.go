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

// NormalizeRepositoryURL checks a repository link and returns it in its
// canonical form: https only, no credentials, query or fragment, a lower-case
// host from RepositoryHosts (any host when anyHost; a port only then), and a
// path naming the repository (owner/name on the known hosts) without a
// trailing slash or ".git". Surrounding spaces are trimmed; an empty link is
// returned as "" (no repository). Anything else is ErrInvalid.
func NormalizeRepositoryURL(raw string, anyHost bool) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", nil
	}
	invalid := func(why string) error { return fmt.Errorf("%w: repository url %s", ErrInvalid, why) }
	if len(s) > MaxRepositoryURL {
		return "", invalid("is too long")
	}
	u, err := url.Parse(s)
	if err != nil {
		return "", invalid("is not a URL")
	}
	if !strings.EqualFold(u.Scheme, "https") || u.Opaque != "" {
		return "", invalid("must use https")
	}
	if u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return "", invalid("must not carry credentials, a query or a fragment")
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return "", invalid("has no host")
	}
	known := slices.Contains(RepositoryHosts, host)
	if !anyHost && (!known || u.Port() != "") {
		return "", invalid("host is not allowed")
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
		return "", invalid("does not name a repository")
	}
	out := "https://" + strings.ToLower(u.Host) + path
	if len(out) > MaxRepositoryURL {
		return "", invalid("is too long")
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
