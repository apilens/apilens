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
)

// MaxPayloadBytesLimit is the largest max_payload_bytes a policy may set.
const MaxPayloadBytesLimit = 1 << 20

// Policy is the capture policy of one app.
type Policy struct {
	// Enabled false tells the SDKs to stop sending records.
	Enabled bool
	// SampleRate is the fraction of requests kept, in [0, 1].
	SampleRate          float64
	CaptureHeaders      bool
	CaptureRequestBody  bool
	CaptureResponseBody bool
	// MaxPayloadBytes caps each captured body; nil means no cap beyond the
	// SDK's own.
	MaxPayloadBytes *int
}

// Default is the policy of an app with no stored row: capture everything.
func Default() Policy {
	return Policy{Enabled: true, SampleRate: 1, CaptureHeaders: true, CaptureRequestBody: true, CaptureResponseBody: true}
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
func (p Policy) Validate() error {
	if math.IsNaN(p.SampleRate) || p.SampleRate < 0 || p.SampleRate > 1 {
		return &InvalidError{Field: "sample_rate", Reason: "must be between 0 and 1"}
	}
	// The column is numeric(5,4): refuse precision it would silently round.
	if r := math.Round(p.SampleRate*1e4) / 1e4; math.Abs(r-p.SampleRate) > 1e-12 {
		return &InvalidError{Field: "sample_rate", Reason: "at most 4 decimal places"}
	}
	if p.MaxPayloadBytes != nil && (*p.MaxPayloadBytes < 1 || *p.MaxPayloadBytes > MaxPayloadBytesLimit) {
		return &InvalidError{Field: "max_payload_bytes", Reason: fmt.Sprintf("must be between 1 and %d", MaxPayloadBytesLimit)}
	}
	return nil
}
