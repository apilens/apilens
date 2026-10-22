// Package buildinfo exposes version metadata injected at link time:
//
//	-ldflags "-X github.com/apilens/apilens/internal/platform/buildinfo.Version=v2.0.0 ..."
package buildinfo

import "runtime/debug"

// Set via -ldflags at build time.
var (
	Version = "dev"
	Commit  = ""
	Date    = ""
)

// Info is the build metadata reported by `apilens version` and /api/v1/meta.
type Info struct {
	Version   string `json:"version"`
	Commit    string `json:"commit,omitempty"`
	Date      string `json:"date,omitempty"`
	GoVersion string `json:"go_version"`
}

// Get returns the build metadata, falling back to VCS info embedded by the Go
// toolchain when ldflags were not set (e.g. `go run`).
func Get() Info {
	info := Info{Version: Version, Commit: Commit, Date: Date}
	if bi, ok := debug.ReadBuildInfo(); ok {
		info.GoVersion = bi.GoVersion
		for _, s := range bi.Settings {
			switch s.Key {
			case "vcs.revision":
				if info.Commit == "" {
					info.Commit = s.Value
				}
			case "vcs.time":
				if info.Date == "" {
					info.Date = s.Value
				}
			}
		}
	}
	return info
}
