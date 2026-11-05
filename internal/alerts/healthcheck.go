package alerts

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/riverqueue/river"

	"github.com/apilens/apilens/internal/controlplane/privacy"
	"github.com/apilens/apilens/internal/controlplane/store/db"
)

// Active HTTP health checks: a project defines URLs of its apps'
// environments (health_checks) and the alerts.health_checks job sends GET
// to each enabled one every HealthCheckInterval, with a HealthCheckTimeout
// timeout and one retry. A check whose retry fails too is down: it opens a
// health_check alert event carrying the failed request (status, latency,
// error class and the start of the response body, masked by the project's
// privacy policy), which notifies every channel of the project like an
// uptime event. The first probe that passes resolves it.
//
// The probes run from the APILens server, so they are guarded against
// server-side request forgery: only http and https URLs without
// credentials, no redirects followed, no proxy, and connections to
// loopback, private, link-local and other non-public addresses refused
// after DNS resolution, unless the install allows private networks
// (alerts.health_checks_allow_private, for self-hosters checking their own
// network).

// HealthCheckInterval is how often every enabled check is probed.
const HealthCheckInterval = time.Minute

// HealthCheckTimeout bounds one attempt: connecting, sending the request
// and reading the response.
const HealthCheckTimeout = 5 * time.Second

// HealthCheckAttempts is how many times a probe tries before the check
// fails: the first attempt and one retry.
const HealthCheckAttempts = 2

// healthCheckRetryDelay is the pause before the retry.
const healthCheckRetryDelay = time.Second

// MaxBodySnippet caps the response body kept with a failed probe, in bytes.
const MaxBodySnippet = 1024

// healthCheckReadLimit is how much of a failed response is read (and
// masked) before it is cut to MaxBodySnippet: masking sees whole JSON
// documents up to this size.
const healthCheckReadLimit = 64 << 10

// healthCheckConcurrency bounds the probes in flight in one run.
const healthCheckConcurrency = 16

// healthCheckUserAgent identifies probe requests to the checked service.
const healthCheckUserAgent = "APILens-HealthCheck/1"

// MaxHealthCheckURLLen bounds a check's URL.
const MaxHealthCheckURLLen = 2048

// HealthCheckURLError is why a URL cannot be checked.
type HealthCheckURLError struct{ reason string }

func (e *HealthCheckURLError) Error() string { return "url " + e.reason }

// ValidateHealthCheckURL checks a health check URL and returns it
// normalized: http or https with a host, no credentials and no fragment,
// at most MaxHealthCheckURLLen bytes. Unless allowPrivate, a host that is
// a non-public IP address or a localhost name is refused here; any other
// name that resolves to a non-public address is refused when the probe
// connects.
func ValidateHealthCheckURL(raw string, allowPrivate bool) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > MaxHealthCheckURLLen {
		return "", &HealthCheckURLError{"must be 1 to 2048 characters"}
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", &HealthCheckURLError{"is not a valid URL"}
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", &HealthCheckURLError{"must start with http:// or https://"}
	}
	if u.Opaque != "" || u.Hostname() == "" {
		return "", &HealthCheckURLError{"must have a host"}
	}
	if u.User != nil {
		return "", &HealthCheckURLError{"must not carry credentials"}
	}
	if u.Fragment != "" || strings.Contains(raw, "#") {
		return "", &HealthCheckURLError{"must not have a fragment"}
	}
	if p := u.Port(); p != "" {
		if n, err := strconv.Atoi(p); err != nil || n < 1 || n > 65535 {
			return "", &HealthCheckURLError{"has an invalid port"}
		}
	}
	if !allowPrivate && !publicHost(u.Hostname()) {
		return "", &HealthCheckURLError{"must point to a public address"}
	}
	return u.String(), nil
}

// publicHost reports whether host may be public: an IP address must be
// globally routable and a name must not be a localhost name. Names are
// checked again at connect time (newGuardedClient).
func publicHost(host string) bool {
	if a, err := netip.ParseAddr(strings.Trim(host, "[]")); err == nil {
		return publicAddr(a)
	}
	h := strings.ToLower(strings.TrimSuffix(host, "."))
	return h != "localhost" && !strings.HasSuffix(h, ".localhost")
}

// HealthCheckResult is what one probe saw: the stored shape of
// health_checks.last_result and of a failed check's alert_events.details.
type HealthCheckResult struct {
	// OK is whether the last attempt answered the expected status.
	OK bool `json:"ok"`
	// StatusCode is the last attempt's response status; 0 when none
	// arrived.
	StatusCode int `json:"status_code"`
	// ExpectedStatus is the status the check expects.
	ExpectedStatus int `json:"expected_status"`
	// LatencyMS is the last attempt's time to the response (or the
	// failure), in milliseconds.
	LatencyMS float64 `json:"latency_ms"`
	// Error is why the last attempt failed, as a failure class ("timeout",
	// "connection refused", "unexpected status 503"); never the URL. Empty
	// when it passed.
	Error string `json:"error,omitempty"`
	// BodySnippet is the start of a failed response's body, masked by the
	// privacy policy and cut to MaxBodySnippet bytes. Empty when the probe
	// passed, the body was empty or not text.
	BodySnippet string `json:"body_snippet,omitempty"`
	// BodyTruncated is true when the body was longer than the snippet.
	BodyTruncated bool `json:"body_truncated,omitempty"`
	// Attempts is how many attempts the probe made (1 or 2).
	Attempts int `json:"attempts"`
	// CheckedAt is when the probe started.
	CheckedAt time.Time `json:"checked_at"`
}

// ProberOptions configures a Prober.
type ProberOptions struct {
	// Client sends the probes. Nil: a client that times out after
	// HealthCheckTimeout, follows no redirects, uses no proxy and refuses
	// non-public addresses unless AllowPrivateNetworks.
	Client *http.Client
	// AllowPrivateNetworks lets the default client reach non-public
	// addresses (self-hosted installs checking their own network).
	AllowPrivateNetworks bool
	// RetryDelay is the pause before the retry; zero is one second.
	RetryDelay time.Duration
	// Timeout bounds one attempt; zero is HealthCheckTimeout.
	Timeout time.Duration
}

// Prober sends health check probes.
type Prober struct {
	client     *http.Client
	retryDelay time.Duration
	timeout    time.Duration
}

// NewProber returns a Prober.
func NewProber(opts ProberOptions) *Prober {
	p := &Prober{client: opts.Client, retryDelay: opts.RetryDelay, timeout: opts.Timeout}
	if p.timeout <= 0 {
		p.timeout = HealthCheckTimeout
	}
	if p.client == nil {
		p.client = newGuardedClient(opts.AllowPrivateNetworks, p.timeout)
	}
	if p.retryDelay <= 0 {
		p.retryDelay = healthCheckRetryDelay
	}
	return p
}

// Probe sends GET to target until it answers expected, at most
// HealthCheckAttempts times. A refused (non-public) address is not
// retried. The body of a failed response is masked with red (nil:
// privacy.Default) before it is cut to MaxBodySnippet. now is the time
// recorded as CheckedAt.
func (p *Prober) Probe(ctx context.Context, target string, expected int, red *privacy.Redactor, now time.Time) HealthCheckResult {
	if red == nil {
		red = privacy.Default
	}
	var r HealthCheckResult
	for attempt := 1; attempt <= HealthCheckAttempts; attempt++ {
		var retry bool
		r, retry = p.attempt(ctx, target, expected, red)
		r.Attempts, r.CheckedAt = attempt, now
		if r.OK || !retry || attempt == HealthCheckAttempts {
			break
		}
		t := time.NewTimer(p.retryDelay)
		select {
		case <-ctx.Done():
			t.Stop()
			return r
		case <-t.C:
		}
	}
	return r
}

// attempt sends one GET. It reports whether a failure is worth retrying.
func (p *Prober) attempt(ctx context.Context, target string, expected int, red *privacy.Redactor) (HealthCheckResult, bool) {
	r := HealthCheckResult{ExpectedStatus: expected}
	ctx, cancel := context.WithTimeout(ctx, p.timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		r.Error = "invalid URL"
		return r, false
	}
	req.Header.Set("User-Agent", healthCheckUserAgent)
	req.Header.Set("Accept", "*/*")
	start := time.Now()
	resp, err := p.client.Do(req)
	if err != nil {
		r.LatencyMS = elapsedMS(start)
		de := transportError(err)
		r.Error = de.reason
		return r, !de.Permanent
	}
	defer func() { _ = resp.Body.Close() }()
	r.StatusCode = resp.StatusCode
	if resp.StatusCode == expected {
		r.LatencyMS = elapsedMS(start)
		r.OK = true
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, healthCheckReadLimit))
		return r, false
	}
	body, readErr := io.ReadAll(io.LimitReader(resp.Body, healthCheckReadLimit+1))
	r.LatencyMS = elapsedMS(start)
	r.Error = "unexpected status " + strconv.Itoa(resp.StatusCode)
	if readErr != nil && len(body) == 0 {
		return r, true
	}
	r.BodySnippet, r.BodyTruncated = bodySnippet(body, red)
	return r, true
}

func elapsedMS(start time.Time) float64 {
	return float64(time.Since(start).Microseconds()) / 1000
}

// bodySnippet masks body with red and cuts it to MaxBodySnippet bytes on a
// character boundary. A body that is not UTF-8 text (an image, compressed
// bytes) is left out: its bytes could not be masked.
func bodySnippet(body []byte, red *privacy.Redactor) (string, bool) {
	truncated := len(body) > healthCheckReadLimit
	if truncated {
		body = body[:healthCheckReadLimit]
		// Cut at the read limit, it may end inside a character.
		for i := 1; i < utf8.UTFMax && len(body) > 0 && !utf8.Valid(body); i++ {
			body = body[:len(body)-1]
		}
	}
	if len(body) == 0 || !utf8.Valid(body) {
		return "", truncated
	}
	s := red.Body(string(body))
	if len(s) <= MaxBodySnippet {
		return s, truncated
	}
	cut := MaxBodySnippet
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut], true
}

// HealthCheckStep is the health check state machine: a check that is up
// goes down (opening an event) when a probe fails; a check that is down
// comes back up (resolving it) when a probe passes. An unknown status is
// treated as up.
func HealthCheckStep(prev UptimeStatus, ok bool) (UptimeStatus, Action) {
	switch {
	case prev == UptimeDown && ok:
		return UptimeUp, ActionResolve
	case prev == UptimeDown:
		return UptimeDown, ActionNone
	case !ok:
		return UptimeDown, ActionTrigger
	default:
		return UptimeUp, ActionNone
	}
}

// HealthCheckTarget is one check the job probes.
type HealthCheckTarget struct {
	ID             uuid.UUID
	ProjectID      uuid.UUID
	AppID          uuid.UUID
	URL            string
	ExpectedStatus int
}

// HealthCheckTransition is the outcome of recording one probe.
type HealthCheckTransition struct {
	From, To UptimeStatus
	Action   Action
	// Event is the event the probe opened or resolved; nil for ActionNone.
	Event *db.AlertEvent
	// Skipped is true when nothing was written: the check was deleted,
	// disabled or changed since it was listed, or already has a probe at
	// or after this one (a retried or overlapping run).
	Skipped bool
}

// HealthCheckTxStore is the control-plane subset recording a probe uses
// inside its transaction; *db.Queries satisfies it.
type HealthCheckTxStore interface {
	LockHealthCheck(ctx context.Context, id uuid.UUID) (db.HealthCheck, error)
	RecordHealthCheckResult(ctx context.Context, arg db.RecordHealthCheckResultParams) error
	GetOpenHealthCheckEvent(ctx context.Context, healthCheckID uuid.UUID) (db.AlertEvent, error)
	OpenHealthCheckEvent(ctx context.Context, arg db.OpenHealthCheckEventParams) (db.AlertEvent, error)
	ResolveAlertEvent(ctx context.Context, arg db.ResolveAlertEventParams) (db.AlertEvent, error)
}

// recordHealthCheck steps target's state with result and writes the new
// state, the result and the event change through s, which must be bound to
// one transaction. It is idempotent: the check is locked first and a probe
// at or before the stored checked_at changes nothing. Going down reuses an
// event that is already open, so alert_events_health_check_open is never
// violated.
func recordHealthCheck(ctx context.Context, s HealthCheckTxStore, target HealthCheckTarget, result HealthCheckResult) (HealthCheckTransition, error) {
	h, err := s.LockHealthCheck(ctx, target.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		return HealthCheckTransition{Skipped: true}, nil
	}
	if err != nil {
		return HealthCheckTransition{}, fmt.Errorf("alerts: lock health check: %w", err)
	}
	prev := UptimeStatus(h.Status)
	now := result.CheckedAt
	if h.Url != target.URL || int(h.ExpectedStatus) != target.ExpectedStatus ||
		(h.CheckedAt != nil && !now.After(*h.CheckedAt)) {
		return HealthCheckTransition{From: prev, To: prev, Skipped: true}, nil
	}
	details, err := json.Marshal(result)
	if err != nil {
		return HealthCheckTransition{}, fmt.Errorf("alerts: encode health check result: %w", err)
	}

	next, action := HealthCheckStep(prev, result.OK)
	t := HealthCheckTransition{From: prev, To: next, Action: action}
	since := h.StatusSince
	switch action {
	case ActionTrigger:
		since = now
		ev, err := s.GetOpenHealthCheckEvent(ctx, h.ID)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			ev, err = s.OpenHealthCheckEvent(ctx, db.OpenHealthCheckEventParams{
				ID: uuid.New(), HealthCheckID: h.ID, Value: result.LatencyMS, StartedAt: now, Details: details,
			})
			if err != nil {
				return HealthCheckTransition{}, fmt.Errorf("alerts: open health check event: %w", err)
			}
		case err != nil:
			return HealthCheckTransition{}, fmt.Errorf("alerts: open health check event: %w", err)
		}
		t.Event = &ev
	case ActionResolve:
		since = now
		ev, err := s.GetOpenHealthCheckEvent(ctx, h.ID)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			// Nothing open to resolve: the state still returns to up.
		case err != nil:
			return HealthCheckTransition{}, fmt.Errorf("alerts: resolve health check event: %w", err)
		default:
			ev, err = s.ResolveAlertEvent(ctx, db.ResolveAlertEventParams{ID: ev.ID, EndedAt: now})
			if err != nil {
				return HealthCheckTransition{}, fmt.Errorf("alerts: resolve health check event: %w", err)
			}
			t.Event = &ev
		}
	}
	if err := s.RecordHealthCheckResult(ctx, db.RecordHealthCheckResultParams{
		ID: h.ID, Status: string(next), StatusSince: since, CheckedAt: now, LastResult: details,
	}); err != nil {
		return HealthCheckTransition{}, fmt.Errorf("alerts: record health check: %w", err)
	}
	return t, nil
}

// HealthCheckStore is the control-plane subset the checker reads outside a
// transaction; *db.Queries satisfies it.
type HealthCheckStore interface {
	ListHealthChecksToRun(ctx context.Context) ([]db.ListHealthChecksToRunRow, error)
}

// RedactorSource returns the privacy policy of an app; *privacy.Resolver
// satisfies it.
type RedactorSource interface {
	Redactor(ctx context.Context, projectID, appID uuid.UUID) (*privacy.Redactor, error)
}

// HealthChecker probes the enabled health checks and records their
// failures as alert events.
type HealthChecker struct {
	pool    Pool
	store   HealthCheckStore
	prober  *Prober
	privacy RedactorSource // nil: privacy.Default
	logger  *slog.Logger
	checks  *prometheus.CounterVec
	events  *prometheus.CounterVec
	// jobs enqueues the alerts.notify job of each event change; nil sends
	// no notifications.
	jobs Enqueuer
}

// NewHealthChecker returns a HealthChecker. reg may be nil.
func NewHealthChecker(pool Pool, prober *Prober, logger *slog.Logger, reg prometheus.Registerer) *HealthChecker {
	c := &HealthChecker{
		pool: pool, store: db.New(pool), prober: prober, logger: logger,
		checks: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "apilens_health_checks_total",
			Help: "Active HTTP health check probes by result (pass, fail, error).",
		}, []string{"result"}),
		events: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "apilens_health_check_events_total",
			Help: "Health check events opened (trigger) and resolved (resolve).",
		}, []string{"action"}),
	}
	if reg != nil {
		reg.MustRegister(c.checks, c.events)
	}
	return c
}

// WithPrivacy masks failed response bodies with the project's and app's
// privacy policies; without it only the built-in defaults apply.
func (c *HealthChecker) WithPrivacy(src RedactorSource) *HealthChecker {
	c.privacy = src
	return c
}

// WithNotifications makes the checker enqueue an alerts.notify job, in the
// transaction that records it, for every event it opens or resolves.
func (c *HealthChecker) WithNotifications(jobs Enqueuer) *HealthChecker {
	c.jobs = jobs
	return c
}

// redactor is the policy the bodies of target's failures are masked with.
// When the policy cannot be read the defaults still apply.
func (c *HealthChecker) redactor(ctx context.Context, target HealthCheckTarget) *privacy.Redactor {
	if c.privacy == nil {
		return privacy.Default
	}
	r, err := c.privacy.Redactor(ctx, target.ProjectID, target.AppID)
	if err != nil || r == nil {
		c.logger.WarnContext(ctx, "alerts: privacy policy unavailable, masking health check body with the defaults",
			"health_check_id", target.ID, "error", err)
		return privacy.Default
	}
	return r
}

// Check probes target at now and records the result.
func (c *HealthChecker) Check(ctx context.Context, target HealthCheckTarget, now time.Time) (HealthCheckTransition, HealthCheckResult, error) {
	result := c.prober.Probe(ctx, target.URL, target.ExpectedStatus, c.redactor(ctx, target), now)
	if err := ctx.Err(); err != nil {
		return HealthCheckTransition{}, result, err
	}
	t, err := c.Record(ctx, target, result)
	return t, result, err
}

// Record writes one probe's result.
func (c *HealthChecker) Record(ctx context.Context, target HealthCheckTarget, result HealthCheckResult) (HealthCheckTransition, error) {
	var t HealthCheckTransition
	err := pgx.BeginFunc(ctx, c.pool, func(tx pgx.Tx) error {
		var err error
		t, err = recordHealthCheck(ctx, db.New(tx), target, result)
		if err != nil || t.Event == nil || c.jobs == nil {
			return err
		}
		kind := NotifyTriggered
		if t.Action == ActionResolve {
			kind = NotifyResolved
		}
		if _, err := c.jobs.InsertTx(ctx, tx, NotifyArgs{EventID: t.Event.ID, Notification: kind}, nil); err != nil {
			return fmt.Errorf("alerts: enqueue notification: %w", err)
		}
		return nil
	})
	switch {
	case err != nil:
		c.checks.WithLabelValues("error").Inc()
		return t, err
	case result.OK:
		c.checks.WithLabelValues("pass").Inc()
	default:
		c.checks.WithLabelValues("fail").Inc()
	}
	if t.Event != nil {
		c.events.WithLabelValues(t.Action.String()).Inc()
	}
	return t, nil
}

// RunOnce probes every enabled check, at most healthCheckConcurrency at a
// time, and returns how many it recorded. A check whose recording fails is
// logged and skipped; it is probed again on the next run. Only failing to
// list the checks is an error.
func (c *HealthChecker) RunOnce(ctx context.Context, now time.Time) (int, error) {
	rows, err := c.store.ListHealthChecksToRun(ctx)
	if err != nil {
		return 0, fmt.Errorf("alerts: list health checks: %w", err)
	}
	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		checked int
		sem     = make(chan struct{}, healthCheckConcurrency)
	)
	for _, r := range rows {
		select {
		case <-ctx.Done():
			wg.Wait()
			return checked, ctx.Err()
		case sem <- struct{}{}:
		}
		wg.Add(1)
		go func(target HealthCheckTarget) {
			defer func() { <-sem; wg.Done() }()
			t, _, err := c.Check(ctx, target, now)
			if err != nil {
				if ctx.Err() == nil {
					c.logger.WarnContext(ctx, "alerts: health check failed to record", "health_check_id", target.ID, "error", err)
				}
				return
			}
			if t.Skipped {
				return
			}
			mu.Lock()
			checked++
			mu.Unlock()
			if t.Event != nil {
				c.logger.InfoContext(ctx, "alerts: health check changed", "health_check_id", target.ID,
					"status", t.To, "event_id", t.Event.ID)
			}
		}(HealthCheckTarget{
			ID: r.ID, ProjectID: r.ProjectID, AppID: r.AppID, URL: r.Url, ExpectedStatus: int(r.ExpectedStatus),
		})
	}
	wg.Wait()
	return checked, ctx.Err()
}

// HealthChecksArgs is the periodic job that probes the health checks.
type HealthChecksArgs struct{}

// Kind is the job kind.
func (HealthChecksArgs) Kind() string { return "alerts.health_checks" }

// HealthChecksWorker works HealthChecksArgs.
type HealthChecksWorker struct {
	river.WorkerDefaults[HealthChecksArgs]
	checker *HealthChecker
	logger  *slog.Logger
}

// NewHealthChecksWorker returns the health checks worker.
func NewHealthChecksWorker(c *HealthChecker, logger *slog.Logger) *HealthChecksWorker {
	return &HealthChecksWorker{checker: c, logger: logger}
}

// Timeout keeps one run inside its period.
func (*HealthChecksWorker) Timeout(*river.Job[HealthChecksArgs]) time.Duration {
	return HealthCheckInterval
}

// Work probes every enabled check now.
func (w *HealthChecksWorker) Work(ctx context.Context, _ *river.Job[HealthChecksArgs]) error {
	n, err := w.checker.RunOnce(ctx, time.Now())
	if n > 0 {
		w.logger.DebugContext(ctx, "alerts: probed health checks", "checks", n)
	}
	return err
}

var _ river.Worker[HealthChecksArgs] = (*HealthChecksWorker)(nil)
