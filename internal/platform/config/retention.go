package config

import "fmt"

// RetentionConfig sets, in days, how long ClickHouse keeps each signal
// (retention.*). `apilens migrate` applies it to the table TTLs; shortening a
// period deletes data and needs -confirm-retention-change. It is per install:
// every project shares it.
type RetentionConfig struct {
	Requests  int `koanf:"requests"`   // api_requests
	Logs      int `koanf:"logs"`       // api_logs
	Spans     int `koanf:"spans"`      // api_spans
	Rollups1m int `koanf:"rollups_1m"` // api_requests_1m
	Rollups1h int `koanf:"rollups_1h"` // api_requests_1h
}

// RetentionBound is the default and the allowed range of one retention key,
// in days.
type RetentionBound struct {
	Key      string // config key under retention.
	Default  int
	Min, Max int
}

// RetentionBounds lists the retention keys with their defaults (the periods
// the schema was created with) and their allowed ranges.
var RetentionBounds = []RetentionBound{
	{Key: "requests", Default: 90, Min: 1, Max: 3650},
	{Key: "logs", Default: 30, Min: 1, Max: 3650},
	{Key: "spans", Default: 30, Min: 1, Max: 3650},
	{Key: "rollups_1m", Default: 30, Min: 1, Max: 400},
	{Key: "rollups_1h", Default: 400, Min: 30, Max: 3650},
}

// Days returns the configured period of a retention key (see
// RetentionBounds), or 0 for an unknown key.
func (r RetentionConfig) Days(key string) int {
	switch key {
	case "requests":
		return r.Requests
	case "logs":
		return r.Logs
	case "spans":
		return r.Spans
	case "rollups_1m":
		return r.Rollups1m
	case "rollups_1h":
		return r.Rollups1h
	}
	return 0
}

// Longest returns the longest configured period, in days: how long any
// telemetry of a project can still exist.
func (r RetentionConfig) Longest() int {
	longest := 0
	for _, b := range RetentionBounds {
		longest = max(longest, r.Days(b.Key))
	}
	return longest
}

func retentionDefaults(m map[string]any) {
	for _, b := range RetentionBounds {
		m["retention."+b.Key] = b.Default
	}
}

func (c *Config) validateRetention() []error {
	var errs []error
	for _, b := range RetentionBounds {
		if d := c.Retention.Days(b.Key); d < b.Min || d > b.Max {
			errs = append(errs, fmt.Errorf("retention.%s %d: want %d to %d days", b.Key, d, b.Min, b.Max))
		}
	}
	return errs
}
