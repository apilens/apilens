package query

import (
	"testing"
	"time"
)

func TestImpactSidesLeaveOutTheDeployMinute(t *testing.T) {
	deploy := time.Date(2026, 11, 5, 10, 37, 20, 0, time.UTC)
	from, minute, afterFrom, to, partial := impactSides(deploy, deploy.Add(3*time.Hour))
	want := func(name string, got, exp time.Time) {
		t.Helper()
		if !got.Equal(exp) {
			t.Errorf("%s = %v, want %v", name, got, exp)
		}
	}
	want("minute", minute, time.Date(2026, 11, 5, 10, 37, 0, 0, time.UTC))
	want("from", from, time.Date(2026, 11, 5, 9, 37, 0, 0, time.UTC))
	want("afterFrom", afterFrom, time.Date(2026, 11, 5, 10, 38, 0, 0, time.UTC))
	want("to", to, time.Date(2026, 11, 5, 11, 38, 0, 0, time.UTC))
	if partial {
		t.Error("a deploy three hours ago has a complete after window")
	}
}

func TestImpactSidesClipAnOpenAfterWindow(t *testing.T) {
	deploy := time.Date(2026, 11, 5, 10, 37, 20, 0, time.UTC)
	now := deploy.Add(20 * time.Minute) // 10:57:20
	_, _, _, to, partial := impactSides(deploy, now)
	if !partial || !to.Equal(time.Date(2026, 11, 5, 10, 58, 0, 0, time.UTC)) {
		t.Fatalf("to = %v partial = %v", to, partial)
	}
}

func TestSideOfWithoutRequestsIsZero(t *testing.T) {
	if s := sideOf(0, 0, nil); s != (sideStats{}) {
		t.Fatalf("empty side = %+v", s)
	}
	s := sideOf(200, 10, []float32{10, 20, 30, 120.456, 300})
	if s.Requests != 200 || s.ErrorRate != 0.05 || s.P95Ms != 120.46 {
		t.Fatalf("side = %+v", s)
	}
}
