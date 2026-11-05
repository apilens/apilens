package alerts

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/controlplane/privacy"
	"github.com/apilens/apilens/internal/controlplane/store/db"
)

// HealthCheckDetails is what a health check notification says beyond the
// app and environment.
type HealthCheckDetails struct {
	CheckID uuid.UUID
	// URL is the checked URL with the values of sensitive query
	// parameters masked.
	URL            string
	ExpectedStatus int
	// Failure is the failed probe that opened the event.
	Failure HealthCheckResult
}

// HealthCheckNotificationFromRow builds the notification of kind about the
// health check event in row. The deep link is the project's health checks
// page, which lists the check's failures with their details.
func HealthCheckNotificationFromRow(kind NotificationKind, row db.GetHealthCheckEventNotificationRow, uiURL string) Notification {
	var failure HealthCheckResult
	if len(row.Details) > 0 {
		// Written by recordHealthCheck; a row that does not decode still
		// notifies, without the failure's details.
		_ = json.Unmarshal(row.Details, &failure)
	}
	n := Notification{
		Kind: kind, EventID: row.ID, ProjectSlug: row.ProjectSlug, AppID: row.AppID, AppName: row.AppName,
		Environment: row.Environment, StartedAt: row.StartedAt.UTC(),
		HealthCheck: &HealthCheckDetails{
			CheckID: row.HealthCheckID, URL: privacy.Default.RawPath(row.Url),
			ExpectedStatus: int(row.ExpectedStatus), Failure: failure,
		},
	}
	if kind == NotifyTriggered {
		v := row.Value
		n.Value = &v
	} else if row.EndedAt != nil {
		t := row.EndedAt.UTC()
		n.EndedAt = &t
	}
	n.URL = HealthChecksURL(uiURL, row.ProjectSlug)
	return n
}

// HealthChecksURL is the UI page of a project's health checks, which shows
// each check's failures with the failed request.
func HealthChecksURL(uiURL, projectSlug string) string {
	return strings.TrimSuffix(uiURL, "/") + "/" + url.PathEscape(projectSlug) + "/settings/health-checks"
}

// FailureText is what a failed probe got, for people: "HTTP 503 (expected
// 200)", or the failure class when no response arrived.
func (r HealthCheckResult) FailureText() string {
	if r.StatusCode != 0 {
		return fmt.Sprintf("HTTP %d (expected %d)", r.StatusCode, r.ExpectedStatus)
	}
	if r.Error != "" {
		return r.Error
	}
	return "no response"
}

func (n Notification) healthCheckTitle() string {
	if n.Kind == NotifyResolved {
		return "Health check passing: " + n.scope()
	}
	return "Health check failing: " + n.scope()
}

func (n Notification) healthCheckSummary() string {
	hc := n.HealthCheck
	if n.Kind == NotifyResolved {
		return fmt.Sprintf("GET %s on %s answers %d again.", hc.URL, n.scope(), hc.ExpectedStatus)
	}
	return fmt.Sprintf("GET %s on %s failed %s: %s.", hc.URL, n.scope(), attemptsText(hc.Failure.Attempts), hc.Failure.FailureText())
}

// attemptsText is "after 2 attempts", "on 1 attempt".
func attemptsText(n int) string {
	if n <= 1 {
		return "on 1 attempt"
	}
	return "after " + strconv.Itoa(n) + " attempts"
}

func formatLatency(ms float64) string { return trimFloat(ms, 1) + " ms" }

func (n Notification) healthCheckFacts() []fact {
	hc := n.HealthCheck
	f := []fact{
		{"App", n.AppName},
		{"Environment", n.Environment},
		{"Check", "GET " + hc.URL},
		{"Expected status", strconv.Itoa(hc.ExpectedStatus)},
	}
	if n.Kind == NotifyTriggered {
		f = append(f,
			fact{"Result", hc.Failure.FailureText()},
			fact{"Latency", formatLatency(hc.Failure.LatencyMS)},
			fact{"Attempts", strconv.Itoa(hc.Failure.Attempts)},
		)
		if hc.Failure.BodySnippet != "" {
			body := hc.Failure.BodySnippet
			if hc.Failure.BodyTruncated {
				body += "…"
			}
			f = append(f, fact{"Response", body})
		}
	}
	f = append(f, fact{"Started", n.StartedAt.Format(time.RFC1123)})
	if n.EndedAt != nil {
		f = append(f, fact{"Resolved", n.EndedAt.Format(time.RFC1123)})
	}
	return f
}

func (n Notification) healthCheckEmailData() map[string]any {
	hc := n.HealthCheck
	d := map[string]any{
		"app":             n.AppName,
		"environment":     n.Environment,
		"check":           withoutScheme(hc.URL),
		"expected_status": strconv.Itoa(hc.ExpectedStatus),
		"started_at":      n.StartedAt.Format(time.RFC3339),
		"project":         n.ProjectSlug,
	}
	if n.Kind == NotifyResolved {
		ended := n.StartedAt
		if n.EndedAt != nil {
			ended = *n.EndedAt
		}
		d["ended_at"] = ended.Format(time.RFC3339)
		return d
	}
	d["result"] = hc.Failure.FailureText()
	d["latency"] = formatLatency(hc.Failure.LatencyMS)
	d["attempts"] = attemptsText(hc.Failure.Attempts)
	d["body"] = hc.Failure.BodySnippet
	d["body_truncated"] = hc.Failure.BodyTruncated
	return d
}

// withoutScheme is u without "https://" or "http://": emails link only to
// the UI.
func withoutScheme(u string) string {
	if _, rest, ok := strings.Cut(u, "://"); ok {
		return rest
	}
	return u
}

// webhookHC is the health check part of a webhook delivery: the check and,
// for health_check.failing, the failed request.
type webhookHC struct {
	ID             uuid.UUID          `json:"id"`
	URL            string             `json:"url"`
	ExpectedStatus int                `json:"expected_status"`
	Failure        *HealthCheckResult `json:"failure,omitempty"`
}

func (n Notification) webhookHealthCheck() *webhookHC {
	hc := n.HealthCheck
	w := &webhookHC{ID: hc.CheckID, URL: hc.URL, ExpectedStatus: hc.ExpectedStatus}
	if n.Kind == NotifyTriggered {
		f := hc.Failure
		w.Failure = &f
	}
	return w
}
