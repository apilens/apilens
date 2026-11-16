package audit

import (
	"testing"
	"time"
)

func TestPrunerCutoff(t *testing.T) {
	now := time.Date(2027, 3, 1, 12, 0, 0, 0, time.FixedZone("x", 3600))
	clock := func() time.Time { return now }

	if _, ok := NewPruner(nil, RetentionOptions{Days: 0, Now: clock}).Cutoff(); ok {
		t.Fatal("retention 0 has a cutoff; want keep forever")
	}
	got, ok := NewPruner(nil, RetentionOptions{Days: 400, Now: clock}).Cutoff()
	if want := time.Date(2026, 1, 25, 11, 0, 0, 0, time.UTC); !ok || !got.Equal(want) {
		t.Fatalf("cutoff = %v %v, want %v", got, ok, want)
	}
	if p := NewPruner(nil, RetentionOptions{Days: 30}); p.opts.Batch != DefaultRetentionBatch || p.opts.Now == nil {
		t.Fatalf("defaults: batch=%d now=%v", p.opts.Batch, p.opts.Now != nil)
	}
}

func TestRetentionKind(t *testing.T) {
	if k := (RetentionArgs{}).Kind(); k != "identity.audit_retention" {
		t.Fatalf("kind = %q", k)
	}
}
