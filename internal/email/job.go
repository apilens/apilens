package email

import (
	"context"
	"log/slog"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/riverqueue/river"
)

// MaxRetries is how many times a failed send is retried (so 1+MaxRetries
// attempts in all) before the job is discarded.
const MaxRetries = 5

// SendArgs is the `email.send` job: render Template with Data and send it to
// To. Enqueue it with jobs.Client.Insert (or InsertTx, so the email goes out
// only if the surrounding transaction commits).
type SendArgs struct {
	To       string         `json:"to"`
	Template string         `json:"template"`
	Data     map[string]any `json:"data,omitempty"`
}

// Kind implements river.JobArgs.
func (SendArgs) Kind() string { return "email.send" }

// InsertOpts implements river.JobArgsWithInsertOpts.
func (SendArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{MaxAttempts: 1 + MaxRetries}
}

// Metric status values.
const (
	StatusSent     = "sent"     // delivered (or logged, for the log provider)
	StatusFailed   = "failed"   // send attempt failed; retried until MaxRetries
	StatusRejected = "rejected" // unknown template or render error; not retried
)

// Metrics counts send attempts.
type Metrics struct {
	sent *prometheus.CounterVec
}

// NewMetrics registers apilens_email_sent_total on reg (nil: unregistered).
func NewMetrics(reg prometheus.Registerer) *Metrics {
	m := &Metrics{sent: prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "apilens_email_sent_total",
		Help: "Email send attempts by template and status (sent, failed, rejected).",
	}, []string{"template", "status"})}
	if reg != nil {
		reg.MustRegister(m.sent)
	}
	return m
}

// Worker works email.send jobs.
type Worker struct {
	river.WorkerDefaults[SendArgs]
	renderer *Renderer
	sender   Sender
	logger   *slog.Logger
	metrics  *Metrics
}

// NewWorker returns the email.send worker. Register it with
// jobs.Register(registry, worker).
func NewWorker(renderer *Renderer, sender Sender, logger *slog.Logger, metrics *Metrics) *Worker {
	if metrics == nil {
		metrics = NewMetrics(nil)
	}
	return &Worker{renderer: renderer, sender: sender, logger: logger, metrics: metrics}
}

// retryBase and retryMax shape the backoff: 30s, 1m, 2m, 4m, 8m.
const (
	retryBase = 30 * time.Second
	retryMax  = 15 * time.Minute
)

// NextRetry backs off exponentially from retryBase, capped at retryMax.
func (w *Worker) NextRetry(job *river.Job[SendArgs]) time.Time {
	return time.Now().Add(backoff(job.Attempt))
}

func backoff(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	if attempt > 10 {
		return retryMax
	}
	return min(retryBase<<(attempt-1), retryMax)
}

// Work renders and sends one email. Logs carry the message id but never the
// body or data (they hold sign-in codes and links).
func (w *Worker) Work(ctx context.Context, job *river.Job[SendArgs]) error {
	args := job.Args
	label := args.Template
	if !w.renderer.Has(label) {
		label = "unknown" // keep the metric's cardinality bounded
	}
	msg, err := w.renderer.Render(args.Template, args.To, args.Data)
	if err != nil {
		w.metrics.sent.WithLabelValues(label, StatusRejected).Inc()
		w.logger.ErrorContext(ctx, "email: render failed; not retrying",
			"job_id", job.ID, "template", args.Template, "error", err)
		return river.JobCancel(err)
	}
	if err := w.sender.Send(ctx, msg); err != nil {
		w.metrics.sent.WithLabelValues(label, StatusFailed).Inc()
		attrs := []any{"job_id", job.ID, "message_id", msg.ID, "template", args.Template,
			"attempt", job.Attempt, "max_attempts", job.MaxAttempts, "error", err}
		if job.Attempt >= job.MaxAttempts {
			w.logger.ErrorContext(ctx, "email: send failed; giving up", attrs...)
		} else {
			w.logger.WarnContext(ctx, "email: send failed; will retry", attrs...)
		}
		return err
	}
	w.metrics.sent.WithLabelValues(label, StatusSent).Inc()
	w.logger.InfoContext(ctx, "email: sent", "job_id", job.ID, "message_id", msg.ID, "template", args.Template)
	return nil
}

var _ river.Worker[SendArgs] = (*Worker)(nil)
