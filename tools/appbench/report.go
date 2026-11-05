package main

import (
	"errors"
	"fmt"
	"math"
	"slices"
	"strings"
	"time"
)

// RunResult is what `appbench run` writes: every app × body size for one posture.
type RunResult struct {
	Posture     string    `json:"posture"`
	StartedAt   time.Time `json:"started_at"`
	Concurrency int       `json:"concurrency"`
	Rate        float64   `json:"rate"`
	Duration    string    `json:"duration"`
	Path        string    `json:"path"`
	Rows        []Row     `json:"rows"`
}

// Row is one measurement: one app, one posture, one body size.
type Row struct {
	App          string  `json:"app"`
	Posture      string  `json:"posture"`
	BodyBytes    int     `json:"body_bytes"`
	Requests     int     `json:"requests"`
	Errors       int     `json:"errors"`
	Missed       int     `json:"missed,omitempty"`
	RPS          float64 `json:"rps"`
	P50Ms        float64 `json:"p50_ms"`
	P95Ms        float64 `json:"p95_ms"`
	P99Ms        float64 `json:"p99_ms"`
	MemoryMiB    float64 `json:"memory_mib,omitempty"`
	MemorySource string  `json:"memory_source,omitempty"`
}

// Thresholds are soft: a breach is annotated, not failed (unless
// -fail-on-threshold). Zero disables a check.
type Thresholds struct {
	AddedP50Small  time.Duration `json:"added_p50_smallest_body"`
	AddedP95       time.Duration `json:"added_p95"`
	AddedMemoryMiB float64       `json:"added_memory_mib"`
}

func defaultThresholds() Thresholds {
	return Thresholds{AddedP50Small: time.Millisecond, AddedP95: 5 * time.Millisecond, AddedMemoryMiB: 128}
}

// ReportRow is a Row joined with the `off` baseline of the same app and size.
type ReportRow struct {
	Row
	AddedP50Ms     *float64 `json:"added_p50_ms,omitempty"`
	AddedP95Ms     *float64 `json:"added_p95_ms,omitempty"`
	AddedMemoryMiB *float64 `json:"added_memory_mib,omitempty"`
	Breaches       []string `json:"breaches,omitempty"`
}

// Report is the joined table plus the settings it was measured with.
type Report struct {
	StartedAt   time.Time   `json:"started_at"`
	Concurrency int         `json:"concurrency"`
	Rate        float64     `json:"rate"`
	Duration    string      `json:"duration"`
	Path        string      `json:"path"`
	Thresholds  Thresholds  `json:"thresholds"`
	Rows        []ReportRow `json:"rows"`
}

func buildReport(runs []RunResult, th Thresholds) (Report, error) {
	type key struct {
		app  string
		size int
	}
	baseline := map[key]Row{}
	var base RunResult
	haveBase := false
	var apps []string
	var smallest int
	for _, run := range runs {
		for _, r := range run.Rows {
			if !slices.Contains(apps, r.App) {
				apps = append(apps, r.App)
			}
			if smallest == 0 || r.BodyBytes < smallest {
				smallest = r.BodyBytes
			}
			if run.Posture != "off" {
				continue
			}
			k := key{r.App, r.BodyBytes}
			if _, dup := baseline[k]; dup {
				return Report{}, fmt.Errorf("two `off` (baseline) rows for %s at %s", r.App, size(r.BodyBytes))
			}
			baseline[k] = r
		}
		if run.Posture == "off" && !haveBase {
			base, haveBase = run, true
		}
	}
	if !haveBase {
		return Report{}, errors.New("no `off` run given: the baseline is needed to compute added latency")
	}

	rep := Report{
		StartedAt: base.StartedAt, Concurrency: base.Concurrency, Rate: base.Rate, Duration: base.Duration,
		Path: base.Path, Thresholds: th,
	}
	for _, run := range runs {
		for _, r := range run.Rows {
			rr := ReportRow{Row: r}
			if r.Errors > 0 {
				rr.Breaches = append(rr.Breaches, fmt.Sprintf("%d non-201 responses", r.Errors))
			}
			if r.Missed*100 > r.Requests+r.Missed { // > 1%: a short pause is not "behind"
				rr.Breaches = append(rr.Breaches, fmt.Sprintf("%d requests not sent (app behind the rate)", r.Missed))
			}
			b, ok := baseline[key{r.App, r.BodyBytes}]
			if ok && r.Posture != "off" {
				p50, p95 := r.P50Ms-b.P50Ms, r.P95Ms-b.P95Ms
				rr.AddedP50Ms, rr.AddedP95Ms = &p50, &p95
				if th.AddedP50Small > 0 && r.BodyBytes == smallest && p50 > toMs(th.AddedP50Small) {
					rr.Breaches = append(rr.Breaches, fmt.Sprintf("added p50 %s > %s", ms(p50), ms(toMs(th.AddedP50Small))))
				}
				if th.AddedP95 > 0 && p95 > toMs(th.AddedP95) {
					rr.Breaches = append(rr.Breaches, fmt.Sprintf("added p95 %s > %s", ms(p95), ms(toMs(th.AddedP95))))
				}
				if r.MemoryMiB > 0 && b.MemoryMiB > 0 {
					mem := r.MemoryMiB - b.MemoryMiB
					rr.AddedMemoryMiB = &mem
					if th.AddedMemoryMiB > 0 && mem > th.AddedMemoryMiB {
						rr.Breaches = append(rr.Breaches, fmt.Sprintf("added memory %.0f MiB > %.0f MiB", mem, th.AddedMemoryMiB))
					}
				}
			}
			rep.Rows = append(rep.Rows, rr)
		}
	}
	slices.SortStableFunc(rep.Rows, func(a, b ReportRow) int {
		if c := slices.Index(apps, a.App) - slices.Index(apps, b.App); c != 0 {
			return c
		}
		if c := a.BodyBytes - b.BodyBytes; c != 0 {
			return c
		}
		return slices.Index(postures, a.Posture) - slices.Index(postures, b.Posture)
	})
	return rep, nil
}

// Breaches lists every soft-threshold breach as "app posture size: reason".
func (r Report) Breaches() []string {
	var out []string
	for _, row := range r.Rows {
		for _, b := range row.Breaches {
			out = append(out, fmt.Sprintf("%s %s %s: %s", row.App, row.Posture, size(row.BodyBytes), b))
		}
	}
	return out
}

// Markdown renders the table published in docs/benchmarks/ and the job summary.
func (r Report) Markdown() string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "## SDK middleware overhead: example apps\n\n")
	load := "back to back (closed loop)"
	if r.Rate > 0 {
		load = fmt.Sprintf("at a fixed %.0f req/s", r.Rate)
	}
	fmt.Fprintf(&sb, "`POST %s` %s over up to %d connections, %s timed per row after warm-up; run started %s.\n",
		r.Path, load, r.Concurrency, r.Duration, r.StartedAt.Format(time.RFC3339))
	fmt.Fprintf(&sb, "*Added* is the difference to the `off` row (no middleware) of the same app and body size.\n\n")
	fmt.Fprintf(&sb, "Soft thresholds (annotated, not failing): %s.\n\n", r.thresholdText())
	sb.WriteString("| App | Body | Posture | p50 | p95 | p99 | Added p50 | Added p95 | req/s | Memory | Added memory | Soft thresholds |\n")
	sb.WriteString("|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---|\n")
	for _, row := range r.Rows {
		status := "ok"
		switch {
		case row.Posture == "off":
			status = "baseline"
		case row.AddedP50Ms == nil:
			status = "no baseline"
		}
		if len(row.Breaches) > 0 {
			status = "**over:** " + strings.Join(row.Breaches, "; ")
		}
		fmt.Fprintf(&sb, "| %s | %s | %s | %s | %s | %s | %s | %s | %.0f | %s | %s | %s |\n",
			row.App, size(row.BodyBytes), row.Posture, ms(row.P50Ms), ms(row.P95Ms), ms(row.P99Ms),
			signedMs(row.AddedP50Ms), signedMs(row.AddedP95Ms), row.RPS,
			mib(row.MemoryMiB), signedMiB(row.AddedMemoryMiB), status)
	}
	return sb.String()
}

func (r Report) thresholdText() string {
	var parts []string
	if r.Thresholds.AddedP50Small > 0 {
		parts = append(parts, fmt.Sprintf("added p50 ≤ %s at the smallest body", ms(toMs(r.Thresholds.AddedP50Small))))
	}
	if r.Thresholds.AddedP95 > 0 {
		parts = append(parts, fmt.Sprintf("added p95 ≤ %s", ms(toMs(r.Thresholds.AddedP95))))
	}
	if r.Thresholds.AddedMemoryMiB > 0 {
		parts = append(parts, fmt.Sprintf("added memory ≤ %.0f MiB", r.Thresholds.AddedMemoryMiB))
	}
	parts = append(parts, "no non-201 responses", "≤ 1% of requests missed at the target rate")
	return strings.Join(parts, ", ")
}

func ms(v float64) string { return fmt.Sprintf("%.2f ms", v) }

func signedMs(v *float64) string {
	if v == nil {
		return "—"
	}
	if math.Abs(*v) < 0.005 {
		return "±0.00 ms"
	}
	return fmt.Sprintf("%+.2f ms", *v)
}

func mib(v float64) string {
	if v <= 0 {
		return "—"
	}
	return fmt.Sprintf("%.0f MiB", v)
}

func signedMiB(v *float64) string {
	if v == nil {
		return "—"
	}
	return fmt.Sprintf("%+.0f MiB", *v)
}

func size(b int) string {
	if b%1024 == 0 {
		return fmt.Sprintf("%d KB", b/1024)
	}
	return fmt.Sprintf("%d B", b)
}
