package query

import (
	"fmt"
	"math"
	"slices"
	"time"
)

// Noisy-instance and memory-leak signals (M7 E3, ADR 0010 D15): computed on
// the server so every client shows the same badges.

const (
	// noisyFactor and the minimum gaps: an instance is noisy when its value
	// is above noisyFactor × the environment median and at least the gap
	// higher.
	noisyFactor       = 1.5
	noisyMinCPUPoints = 20.0  // CPU percentage points
	noisyMinP95Ms     = 100.0 // milliseconds
	// noisyMinPeers is how many live instances an environment needs before
	// one of them can stand out.
	noisyMinPeers = 3

	// leakWindow is the history a leak is fitted on; leakMinSpan the least
	// of it with data, leakMinPoints the fewest points, leakMinR2 how well
	// a line must fit and leakMinGrowth how much it must grow over the
	// fitted span (smaller is noise, not a leak).
	leakWindow    = 6 * time.Hour
	leakMinSpan   = 2 * time.Hour
	leakMinPoints = 12
	leakMinR2     = 0.8
	leakMinGrowth = 1 << 20 // bytes

	mib = 1 << 20
)

// InstanceSignal is a badge on an instance.
type InstanceSignal struct {
	Kind   string  `json:"kind" enum:"noisy,leak" doc:"noisy: CPU or p95 over the last 15 minutes well above the environment's median (at least 3 live instances); leak: memory grew steadily over the last 6 hours."`
	Metric string  `json:"metric" doc:"What the signal is on: cpu_pct or p95_ms (noisy); heap_after_gc, heap_used, mem_pss or mem_rss (leak)."`
	Value  float64 `json:"value" doc:"noisy: the instance's value (percent or ms); leak: growth in MB (2^20 bytes) per hour."`
	Detail string  `json:"detail" doc:"One line for the badge's tooltip: the median it is compared with, or the fit and the time until the memory limit when one is known."`
}

// instanceKey names an instance across environments.
type instanceKey struct{ env, id string }

// median of vs; vs must not be empty. It sorts a copy.
func median(vs []float64) float64 {
	s := slices.Clone(vs)
	slices.Sort(s)
	if n := len(s); n%2 == 1 {
		return s[n/2]
	} else {
		return (s[n/2-1] + s[n/2]) / 2
	}
}

// noisyInstances returns, per noisy instance, its environment's median and
// the number of peers it was compared with. Environments with fewer than
// noisyMinPeers instances never have a noisy one.
func noisyInstances(values map[instanceKey]float64, minGap float64) map[instanceKey][2]float64 {
	byEnv := map[string][]float64{}
	for k, v := range values {
		byEnv[k.env] = append(byEnv[k.env], v)
	}
	out := map[instanceKey][2]float64{}
	for k, v := range values {
		peers := byEnv[k.env]
		if len(peers) < noisyMinPeers {
			continue
		}
		med := median(peers)
		if v > noisyFactor*med && v-med >= minGap {
			out[k] = [2]float64{med, float64(len(peers))}
		}
	}
	return out
}

// noisySignal renders a noisy instance's badge.
func noisySignal(metric string, value, med float64, peers int) InstanceSignal {
	unit, val, m := "%", round2(value), round2(med)
	if metric == "p95_ms" {
		unit = " ms"
	}
	what := map[string]string{"cpu_pct": "CPU", "p95_ms": "p95"}[metric]
	return InstanceSignal{
		Kind: "noisy", Metric: metric, Value: val,
		Detail: fmt.Sprintf("%s %g%s over 15 min vs a median of %g%s across %d instances", what, val, unit, m, unit, peers),
	}
}

// seriesPoint is one value of a time series.
type seriesPoint struct {
	t time.Time
	v float64
}

// linearFit is the least-squares line through pts: the slope per second,
// the value of the line at the last point and R². ok is false with fewer
// than 2 distinct times.
func linearFit(pts []seriesPoint) (slope, last, r2 float64, ok bool) {
	n := float64(len(pts))
	if len(pts) < 2 {
		return 0, 0, 0, false
	}
	t0 := pts[0].t
	var sx, sy, sxx, sxy, syy float64
	for _, p := range pts {
		x := p.t.Sub(t0).Seconds()
		sx += x
		sy += p.v
		sxx += x * x
		sxy += x * p.v
		syy += p.v * p.v
	}
	vx := n*sxx - sx*sx
	if vx <= 0 {
		return 0, 0, 0, false
	}
	slope = (n*sxy - sx*sy) / vx
	intercept := (sy - slope*sx) / n
	last = intercept + slope*pts[len(pts)-1].t.Sub(t0).Seconds()
	vy := n*syy - sy*sy
	switch {
	case vy <= 0:
		r2 = 1 // a flat line fits itself; slope is 0 then
	default:
		r := (n*sxy - sx*sy) / math.Sqrt(vx*vy)
		r2 = r * r
	}
	return slope, last, r2, true
}

// leakSignal is the leak badge of a memory series (bytes, oldest first), or
// nil: it needs leakMinSpan of data, a positive slope with R² above
// leakMinR2 and at least leakMinGrowth over the fitted span. limit, when
// known, adds the time until the line reaches it.
func leakSignal(metric string, pts []seriesPoint, limit *float64) *InstanceSignal {
	if len(pts) < leakMinPoints {
		return nil
	}
	span := pts[len(pts)-1].t.Sub(pts[0].t)
	if span < leakMinSpan {
		return nil
	}
	slope, last, r2, ok := linearFit(pts)
	if !ok || slope <= 0 || r2 <= leakMinR2 || slope*span.Seconds() < leakMinGrowth {
		return nil
	}
	perHour := slope * 3600 / mib
	detail := fmt.Sprintf("Grows %g MB/h over the last %s (R² %.2f)", round2(perHour), hours(span), r2)
	if limit != nil && *limit > last {
		detail += fmt.Sprintf("; reaches the %g MB limit in about %s", round2(*limit/mib),
			hours(time.Duration((*limit-last)/slope*float64(time.Second))))
	}
	return &InstanceSignal{Kind: "leak", Metric: metric, Value: round2(perHour), Detail: detail}
}

// hours renders a duration for a tooltip: minutes under an hour, hours
// with one decimal under two days, days beyond.
func hours(d time.Duration) string {
	switch {
	case d < time.Hour:
		return fmt.Sprintf("%d min", max(1, int(d.Minutes())))
	case d < 48*time.Hour:
		return fmt.Sprintf("%g h", math.Round(d.Hours()*10)/10)
	default:
		return fmt.Sprintf("%g days", math.Round(d.Hours()/24*10)/10)
	}
}
