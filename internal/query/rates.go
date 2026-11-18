package query

import "time"

// perMinute is the per-minute rate of n requests in w. It divides by the
// active span, min(range, now - first), so a project, endpoint or consumer
// that started sending part-way through the range is not diluted by the
// empty minutes before its first request. first is the start of the first
// bucket with data, the zero time without any. The span never drops below a
// minute, so a first request seconds ago does not read as a burst.
func perMinute(n uint64, w window, now, first time.Time) float64 {
	if n == 0 {
		return 0
	}
	span := w.to.Sub(w.from)
	if !first.IsZero() && first.After(w.from) {
		span = min(span, now.Sub(first))
	}
	return float64(n) / max(span, time.Minute).Minutes()
}

// firstBucket is the earliest bucket of got holding a request, the zero
// time when none does.
func firstBucket(got map[int64]StatusSplit) time.Time {
	var first int64
	found := false
	for t, sp := range got {
		if sp.Requests > 0 && (!found || t < first) {
			first, found = t, true
		}
	}
	if !found {
		return time.Time{}
	}
	return time.Unix(first, 0).UTC()
}
