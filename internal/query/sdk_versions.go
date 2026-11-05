package query

import (
	_ "embed"
	"encoding/json"
	"strconv"
	"strings"
)

// sdkLatestJSON maps each SDK's heartbeat sdk_name to its latest released
// version. release-please rewrites the entries on every SDK release (see the
// extra-files of release-please-config.json); do not edit them by hand.
//
//go:embed sdk_latest.json
var sdkLatestJSON []byte

// sdkLatest is sdkLatestJSON decoded.
var sdkLatest = mustSDKLatest(sdkLatestJSON)

func mustSDKLatest(b []byte) map[string]string {
	m := map[string]string{}
	if err := json.Unmarshal(b, &m); err != nil {
		panic("query: sdk_latest.json: " + err.Error())
	}
	return m
}

// latestSDKVersion is the latest released version of an SDK, "" when the SDK
// is not one of ours.
func latestSDKVersion(name string) string {
	return sdkLatest[name]
}

// sdkOutdated reports whether version is older than latest. Versions that do
// not parse as MAJOR.MINOR.PATCH (an optional leading v, pre-release and
// build suffixes allowed) are never outdated.
func sdkOutdated(version, latest string) bool {
	v, vpre, ok := parseVersion(version)
	l, lpre, lok := parseVersion(latest)
	if !ok || !lok {
		return false
	}
	for i := range v {
		if v[i] != l[i] {
			return v[i] < l[i]
		}
	}
	// Same core: a pre-release precedes the release.
	return vpre && !lpre
}

func parseVersion(s string) (core [3]int, pre, ok bool) {
	s = strings.TrimPrefix(strings.TrimSpace(s), "v")
	if i := strings.IndexByte(s, '+'); i >= 0 {
		s = s[:i]
	}
	if i := strings.IndexByte(s, '-'); i >= 0 {
		s, pre = s[:i], true
	}
	parts := strings.Split(s, ".")
	if len(parts) != 3 {
		return core, false, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return core, false, false
		}
		core[i] = n
	}
	return core, pre, true
}
