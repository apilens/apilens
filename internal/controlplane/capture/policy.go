// Package capture stores the remote capture policy of each app: whether its
// SDKs capture at all, the fraction of requests they keep and which parts of
// a request they record. SDKs receive it on heartbeat, so a change reaches
// them without a redeploy. An app without a stored policy captures
// everything (Default).
package capture

import (
	"errors"
	"fmt"
	"math"
	"slices"
)

const (
	// DefaultMaxPayloadBytes caps each captured body of an app whose policy
	// sets no max_payload_bytes: ingest stores at most this much per body.
	DefaultMaxPayloadBytes = 64 << 10
	// DefaultMaxPayloadBytesLimit is the largest max_payload_bytes a policy
	// may set unless the operator changes ingest.max_payload_bytes_limit.
	DefaultMaxPayloadBytesLimit = 1 << 20
)

// Policy is the capture policy of one app.
type Policy struct {
	// Enabled false tells the SDKs to stop sending records.
	Enabled bool
	// SampleRate is the fraction of requests kept, in [0, 1].
	SampleRate          float64
	CaptureHeaders      bool
	CaptureRequestBody  bool
	CaptureResponseBody bool
	// MaxPayloadBytes caps each captured body; nil means the server default,
	// DefaultMaxPayloadBytes.
	MaxPayloadBytes *int
	// Resources narrows the SDKs' runtime resources sampling (M7).
	Resources ResourcesPolicy
}

// Runtime resources sampling bounds (seconds): SDKs sample every 15 s by
// default; a policy may ask for up to 10 minutes between samples.
const (
	ResourcesMinIntervalS = 15
	ResourcesMaxIntervalS = 600
)

// ResourceCollectors are the runtime resources collectors a policy can turn
// off, in a fixed order (CollectorSet bit i is ResourceCollectors[i]).
var ResourceCollectors = []string{
	"process.cpu", "process.memory", "process.pss", "container.cpu",
	"container.memory", "runtime", "pools", "processes",
}

// CollectorSet is a set of ResourceCollectors. It is a bitmask so Policy
// stays comparable.
type CollectorSet uint16

// ParseCollectors returns the set of names, or the first unknown name.
func ParseCollectors(names []string) (CollectorSet, string) {
	var c CollectorSet
	for _, n := range names {
		i := slices.Index(ResourceCollectors, n)
		if i < 0 {
			return 0, n
		}
		c |= 1 << i
	}
	return c, ""
}

// Names lists the set in ResourceCollectors order; never nil.
func (c CollectorSet) Names() []string {
	out := []string{}
	for i, n := range ResourceCollectors {
		if c&(1<<i) != 0 {
			out = append(out, n)
		}
	}
	return out
}

// ResourcesPolicy can only narrow runtime resources sampling, never widen
// what an SDK's local config allows.
type ResourcesPolicy struct {
	// Enabled false tells the SDKs to stop sampling resources.
	Enabled bool
	// MinIntervalS is the shortest sampling interval the SDKs may use; 0
	// stored as ResourcesMinIntervalS.
	MinIntervalS int
	// Disabled are the collectors the SDKs must skip.
	Disabled CollectorSet
}

// Default is the policy of an app with no stored row: capture everything.
func Default() Policy {
	return Policy{Enabled: true, SampleRate: 1, CaptureHeaders: true, CaptureRequestBody: true, CaptureResponseBody: true,
		Resources: ResourcesPolicy{Enabled: true, MinIntervalS: ResourcesMinIntervalS}}
}

// ErrInvalid is wrapped by every *InvalidError.
var ErrInvalid = errors.New("capture: invalid policy")

// InvalidError names the first unusable field of a policy.
type InvalidError struct {
	Field  string
	Reason string
}

func (e *InvalidError) Error() string { return fmt.Sprintf("%s: %s", e.Field, e.Reason) }

// Unwrap makes errors.Is(err, ErrInvalid) hold.
func (e *InvalidError) Unwrap() error { return ErrInvalid }

// Validate reports the first field outside its range as an *InvalidError.
// limit is the largest max_payload_bytes allowed (the operator's
// ingest.max_payload_bytes_limit).
func (p Policy) Validate(limit int) error {
	if math.IsNaN(p.SampleRate) || p.SampleRate < 0 || p.SampleRate > 1 {
		return &InvalidError{Field: "sample_rate", Reason: "must be between 0 and 1"}
	}
	// The column is numeric(5,4): refuse precision it would silently round.
	if r := math.Round(p.SampleRate*1e4) / 1e4; math.Abs(r-p.SampleRate) > 1e-12 {
		return &InvalidError{Field: "sample_rate", Reason: "at most 4 decimal places"}
	}
	if p.MaxPayloadBytes != nil && (*p.MaxPayloadBytes < 1 || *p.MaxPayloadBytes > limit) {
		return &InvalidError{Field: "max_payload_bytes", Reason: fmt.Sprintf("must be between 1 and %d", limit)}
	}
	// 0 is unset: the default interval.
	if i := p.Resources.MinIntervalS; i != 0 && (i < ResourcesMinIntervalS || i > ResourcesMaxIntervalS) {
		return &InvalidError{Field: "resources.min_interval_s", Reason: fmt.Sprintf("must be between %d and %d", ResourcesMinIntervalS, ResourcesMaxIntervalS)}
	}
	return nil
}
