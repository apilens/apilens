package query

import (
	"math"
	"testing"
	"time"
)

func TestPerMinute(t *testing.T) {
	now := time.Date(2026, 11, 16, 12, 7, 30, 0, time.UTC)
	w, err := resolveWindow("24h", now)
	if err != nil {
		t.Fatal(err)
	}
	hourAgo := now.Add(-time.Hour)
	for _, tc := range []struct {
		name  string
		n     uint64
		first time.Time
		want  float64
	}{
		// 1 h of data in a 24 h range is the 1 h rate, not diluted by 23 empty hours.
		{"young", 600, hourAgo, 10},
		{"full range", 1440, w.from, 1},
		{"first before range", 1440, w.from.Add(-time.Hour), 1},
		{"no first", 1440, time.Time{}, 1},
		{"seconds old floors at a minute", 5, now.Add(-10 * time.Second), 5},
		{"no requests", 0, hourAgo, 0},
	} {
		if got := perMinute(tc.n, w, now, tc.first); math.Abs(got-tc.want) > 1e-9 {
			t.Errorf("%s: perMinute = %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestFirstBucket(t *testing.T) {
	a := time.Date(2026, 11, 16, 11, 0, 0, 0, time.UTC)
	got := map[int64]StatusSplit{
		a.Add(-15 * time.Minute).Unix(): {},
		a.Add(15 * time.Minute).Unix():  {Requests: 2},
		a.Unix():                        {Requests: 1},
	}
	if f := firstBucket(got); !f.Equal(a) {
		t.Fatalf("firstBucket = %v, want %v", f, a)
	}
	if f := firstBucket(map[int64]StatusSplit{a.Unix(): {}}); !f.IsZero() {
		t.Fatalf("firstBucket without requests = %v, want zero", f)
	}
}
