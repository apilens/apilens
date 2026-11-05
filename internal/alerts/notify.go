package alerts

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"

	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/email"
	idkeys "github.com/apilens/apilens/internal/identity/keys"
)

// Notifications run as two River jobs:
//
//   - alerts.notify, one per event transition (triggered or resolved), is
//     inserted in the transaction that records the evaluation, so it exists
//     exactly when the event changed. It fans out one alerts.deliver job per
//     channel of the rule.
//   - alerts.deliver sends to one channel and is retried on its own, so a
//     failing Slack webhook neither delays nor repeats the email. Email
//     channels enqueue one email.send job per address; Slack, Teams and
//     webhook channels are posted over HTTP.
//
// Uptime events (kind uptime, see UptimeChecker) go through the same jobs.
// They have no rule: they notify every channel of the project, and nothing
// while their environment is muted. Health check events (kind
// health_check, see HealthChecker) do the same, and notify nothing while
// their check is disabled.
//
// Job args carry ids only: channel configs (addresses, webhook URLs, signing
// secrets) are opened in the worker and never stored in the job, logged or
// put in an error.

// NotifyMaxRetries is how many times a failed notify or deliver job is
// retried (so 1+NotifyMaxRetries attempts) before it is discarded.
const NotifyMaxRetries = 5

// deliverJobTimeout bounds one delivery attempt.
const deliverJobTimeout = 30 * time.Second

// NotifyArgs is the alerts.notify job.
type NotifyArgs struct {
	EventID      uuid.UUID        `json:"event_id"`
	Notification NotificationKind `json:"kind"`
}

// Kind is the job kind.
func (NotifyArgs) Kind() string { return "alerts.notify" }

// InsertOpts makes the job unique per event and kind, so a retried or
// replayed evaluation cannot notify twice.
func (NotifyArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{MaxAttempts: 1 + NotifyMaxRetries, UniqueOpts: river.UniqueOpts{ByArgs: true}}
}

// DeliverArgs is the alerts.deliver job.
type DeliverArgs struct {
	EventID      uuid.UUID        `json:"event_id"`
	ChannelID    uuid.UUID        `json:"channel_id"`
	Notification NotificationKind `json:"kind"`
}

// Kind is the job kind.
func (DeliverArgs) Kind() string { return "alerts.deliver" }

// InsertOpts makes the job unique per event, channel and kind.
func (DeliverArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{MaxAttempts: 1 + NotifyMaxRetries, UniqueOpts: river.UniqueOpts{ByArgs: true}}
}

// DeliveryID identifies one delivery to webhook receivers
// (X-APILens-Delivery); retries keep it.
func (a DeliverArgs) DeliveryID() string {
	return uuid.NewSHA1(deliveryNamespace, []byte(a.EventID.String()+"/"+a.ChannelID.String()+"/"+string(a.Notification))).String()
}

var deliveryNamespace = uuid.MustParse("6f1d7c39-3b0e-4f43-9a51-2d1c5b0e7a10")

// Enqueuer inserts jobs inside a transaction; *jobs.Client satisfies it.
type Enqueuer interface {
	InsertTx(ctx context.Context, tx pgx.Tx, args river.JobArgs, opts *river.InsertOpts) (*rivertype.JobInsertResult, error)
}

// NotifyStore is the control-plane subset the notification jobs read and
// write; *db.Queries satisfies it.
type NotifyStore interface {
	GetAlertEventNotification(ctx context.Context, id uuid.UUID) (db.GetAlertEventNotificationRow, error)
	ListNotificationChannelsByIDs(ctx context.Context, arg db.ListNotificationChannelsByIDsParams) ([]db.NotificationChannel, error)
	GetNotificationChannel(ctx context.Context, arg db.GetNotificationChannelParams) (db.NotificationChannel, error)
	MarkAlertEventNotified(ctx context.Context, arg db.MarkAlertEventNotifiedParams) (int64, error)
	GetUptimeEventNotification(ctx context.Context, id uuid.UUID) (db.GetUptimeEventNotificationRow, error)
	GetHealthCheckEventNotification(ctx context.Context, id uuid.UUID) (db.GetHealthCheckEventNotificationRow, error)
}

// eventTarget is what the notification jobs need of an event of either
// kind.
type eventTarget struct {
	projectID  uuid.UUID
	channelIDs []uuid.UUID
	notifiedAt *time.Time
	// muted is true for an uptime event whose environment is muted, and
	// for a health check event whose check is disabled.
	muted bool
	note  func(kind NotificationKind, uiURL string) Notification
}

// target reads the event: a rule's (threshold) event, else an uptime
// event, else a health check event. It returns pgx.ErrNoRows when the
// event, or its rule or check, is gone.
func (n *Notifier) target(ctx context.Context, id uuid.UUID) (eventTarget, error) {
	row, err := n.store.GetAlertEventNotification(ctx, id)
	if err == nil {
		return eventTarget{
			projectID: row.ProjectID, channelIDs: row.ChannelIds, notifiedAt: row.NotifiedAt,
			note: func(kind NotificationKind, uiURL string) Notification { return NotificationFromRow(kind, row, uiURL) },
		}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return eventTarget{}, err
	}
	up, err := n.store.GetUptimeEventNotification(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		hc, err := n.store.GetHealthCheckEventNotification(ctx, id)
		if err != nil {
			return eventTarget{}, err
		}
		return eventTarget{
			projectID: hc.ProjectID, channelIDs: hc.ChannelIds, notifiedAt: hc.NotifiedAt, muted: !hc.Enabled,
			note: func(kind NotificationKind, uiURL string) Notification {
				return HealthCheckNotificationFromRow(kind, hc, uiURL)
			},
		}, nil
	}
	if err != nil {
		return eventTarget{}, err
	}
	return eventTarget{
		projectID: up.ProjectID, channelIDs: up.ChannelIds, notifiedAt: up.NotifiedAt, muted: up.Muted,
		note: func(kind NotificationKind, uiURL string) Notification {
			return UptimeNotificationFromRow(kind, up, uiURL)
		},
	}, nil
}

// NotifierOptions configures a Notifier.
type NotifierOptions struct {
	// PublicUIURL (identity.public_ui_url) is where incident links point.
	PublicUIURL string
	// Sealer opens channel configs; nil (no identity.key_encryption_key in
	// this process) makes every delivery fail without retrying.
	Sealer *idkeys.Sealer
	// Poster posts Slack, Teams and webhook notifications; nil is
	// NewPoster(PosterOptions{}).
	Poster *Poster
	// Now is the clock; nil is time.Now.
	Now func() time.Time
}

// Notifier works the notification jobs.
type Notifier struct {
	store  NotifyStore
	jobs   Enqueuer
	inTx   func(ctx context.Context, fn func(tx pgx.Tx, q NotifyStore) error) error
	opts   NotifierOptions
	logger *slog.Logger
	sent   *prometheus.CounterVec
}

// NewNotifier returns a Notifier over pool. reg may be nil.
func NewNotifier(pool Pool, jobs Enqueuer, opts NotifierOptions, logger *slog.Logger, reg prometheus.Registerer) *Notifier {
	n := newNotifier(db.New(pool), jobs, func(ctx context.Context, fn func(pgx.Tx, NotifyStore) error) error {
		return pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error { return fn(tx, db.New(tx)) })
	}, opts, logger)
	if reg != nil {
		reg.MustRegister(n.sent)
	}
	return n
}

func newNotifier(store NotifyStore, jobs Enqueuer, inTx func(context.Context, func(pgx.Tx, NotifyStore) error) error,
	opts NotifierOptions, logger *slog.Logger) *Notifier {
	if opts.Poster == nil {
		opts.Poster = NewPoster(PosterOptions{})
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	return &Notifier{
		store: store, jobs: jobs, inTx: inTx, opts: opts, logger: logger,
		sent: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "apilens_alerts_notifications_total",
			Help: "Alert notification deliveries by channel type and result (sent, failed, dropped).",
		}, []string{"channel", "result"}),
	}
}

// Notification results for apilens_alerts_notifications_total.
const (
	resultSent    = "sent"    // delivered, or handed to email.send
	resultFailed  = "failed"  // will be retried
	resultDropped = "dropped" // not retried: channel gone, bad config, permanent HTTP error
)

// FanOut enqueues one alerts.deliver job per channel of the event's rule
// (for an uptime event, of its project; none while its environment is
// muted). It returns how many it enqueued.
func (n *Notifier) FanOut(ctx context.Context, args NotifyArgs) (int, error) {
	if !args.Notification.Valid() {
		return 0, river.JobCancel(fmt.Errorf("alerts: unknown notification kind %q", args.Notification))
	}
	row, err := n.target(ctx, args.EventID)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil // the rule (and its events) was deleted
	}
	if err != nil {
		return 0, fmt.Errorf("alerts: read event: %w", err)
	}
	if len(row.channelIDs) == 0 || row.muted {
		return 0, nil
	}
	count := 0
	err = n.inTx(ctx, func(tx pgx.Tx, q NotifyStore) error {
		count = 0
		chans, err := q.ListNotificationChannelsByIDs(ctx, db.ListNotificationChannelsByIDsParams{ProjectID: row.projectID, Ids: row.channelIDs})
		if err != nil {
			return fmt.Errorf("alerts: list channels: %w", err)
		}
		for _, ch := range chans {
			if _, err := n.jobs.InsertTx(ctx, tx, DeliverArgs{EventID: args.EventID, ChannelID: ch.ID, Notification: args.Notification}, nil); err != nil {
				return fmt.Errorf("alerts: enqueue delivery: %w", err)
			}
			count++
		}
		return nil
	})
	return count, err
}

// Deliver sends one notification to one channel. It reports false, with no
// error, when there is nothing to send any more (the event, the channel or
// its place on the rule is gone, or the uptime event's environment was
// muted since). Errors that a retry cannot fix are wrapped
// in river.JobCancel.
func (n *Notifier) Deliver(ctx context.Context, args DeliverArgs) (bool, error) {
	if !args.Notification.Valid() {
		return false, river.JobCancel(fmt.Errorf("alerts: unknown notification kind %q", args.Notification))
	}
	row, err := n.target(ctx, args.EventID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("alerts: read event: %w", err)
	}
	if !slices.Contains(row.channelIDs, args.ChannelID) || row.muted {
		return false, nil // removed from the rule since the event changed, or muted
	}
	ch, err := n.store.GetNotificationChannel(ctx, db.GetNotificationChannelParams{ProjectID: row.projectID, ID: args.ChannelID})
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil // deleted
	}
	if err != nil {
		return false, fmt.Errorf("alerts: read channel: %w", err)
	}
	typ := ChannelType(ch.Type)
	label := string(typ)
	if !typ.Valid() {
		label = "unknown"
	}
	cfg, err := n.channelConfig(ch)
	if err != nil {
		n.sent.WithLabelValues(label, resultDropped).Inc()
		return false, river.JobCancel(err)
	}
	note := row.note(args.Notification, n.opts.PublicUIURL)

	if typ == ChannelEmail {
		err = n.inTx(ctx, func(tx pgx.Tx, q NotifyStore) error {
			for _, to := range cfg.Email.Addresses {
				if _, err := n.jobs.InsertTx(ctx, tx, email.SendArgs{
					To: to, Template: note.EmailTemplate(), Data: note.EmailData(),
				}, nil); err != nil {
					return fmt.Errorf("alerts: enqueue email: %w", err)
				}
			}
			return n.markNotified(ctx, q, args, row)
		})
		if err != nil {
			n.sent.WithLabelValues(label, resultFailed).Inc()
			return false, err
		}
		n.sent.WithLabelValues(label, resultSent).Inc()
		return true, nil
	}

	if err := n.opts.Poster.Post(ctx, cfg, note, args.DeliveryID()); err != nil {
		var de *DeliveryError
		if errors.As(err, &de) && de.Permanent {
			n.sent.WithLabelValues(label, resultDropped).Inc()
			return false, river.JobCancel(err)
		}
		n.sent.WithLabelValues(label, resultFailed).Inc()
		return false, err
	}
	n.sent.WithLabelValues(label, resultSent).Inc()
	if err := n.markNotified(ctx, n.store, args, row); err != nil {
		// Delivered: do not retry (and resend) for the bookkeeping.
		n.logger.WarnContext(ctx, "alerts: record notified_at failed", "event_id", args.EventID, "error", err)
	}
	return true, nil
}

// markNotified records the event's first triggered notification.
func (n *Notifier) markNotified(ctx context.Context, q NotifyStore, args DeliverArgs, row eventTarget) error {
	if args.Notification != NotifyTriggered || row.notifiedAt != nil {
		return nil
	}
	if _, err := q.MarkAlertEventNotified(ctx, db.MarkAlertEventNotifiedParams{ID: args.EventID, NotifiedAt: n.opts.Now()}); err != nil {
		return fmt.Errorf("alerts: mark notified: %w", err)
	}
	return nil
}

// channelConfig opens and parses a channel's sealed config. Its errors
// never include config values.
func (n *Notifier) channelConfig(ch db.NotificationChannel) (ChannelConfig, error) {
	if n.opts.Sealer == nil {
		return ChannelConfig{}, errors.New("alerts: no identity.key_encryption_key in this process; cannot open channel config")
	}
	raw, err := OpenChannelConfig(n.opts.Sealer, ch.ID, ch.ConfigEnc)
	if err != nil {
		return ChannelConfig{}, fmt.Errorf("alerts: open channel config: %w", err)
	}
	return ParseChannelConfig(ChannelType(ch.Type), raw)
}

// NotifyWorker works alerts.notify jobs.
type NotifyWorker struct {
	river.WorkerDefaults[NotifyArgs]
	notifier *Notifier
}

// NewNotifyWorker returns the alerts.notify worker.
func NewNotifyWorker(n *Notifier) *NotifyWorker { return &NotifyWorker{notifier: n} }

// Work fans the event out to its rule's channels.
func (w *NotifyWorker) Work(ctx context.Context, job *river.Job[NotifyArgs]) error {
	count, err := w.notifier.FanOut(ctx, job.Args)
	if err != nil {
		w.notifier.logger.WarnContext(ctx, "alerts: notification fan-out failed",
			"job_id", job.ID, "event_id", job.Args.EventID, "kind", job.Args.Notification, "attempt", job.Attempt, "error", err)
		return err
	}
	w.notifier.logger.DebugContext(ctx, "alerts: notification fanned out",
		"job_id", job.ID, "event_id", job.Args.EventID, "kind", job.Args.Notification, "channels", count)
	return nil
}

// DeliverWorker works alerts.deliver jobs.
type DeliverWorker struct {
	river.WorkerDefaults[DeliverArgs]
	notifier *Notifier
}

// NewDeliverWorker returns the alerts.deliver worker.
func NewDeliverWorker(n *Notifier) *DeliverWorker { return &DeliverWorker{notifier: n} }

// Timeout bounds one delivery attempt.
func (*DeliverWorker) Timeout(*river.Job[DeliverArgs]) time.Duration { return deliverJobTimeout }

// Work delivers one notification. Logs carry ids and the failure class,
// never the channel's addresses, URL or secret.
func (w *DeliverWorker) Work(ctx context.Context, job *river.Job[DeliverArgs]) error {
	a := job.Args
	sent, err := w.notifier.Deliver(ctx, a)
	attrs := []any{"job_id", job.ID, "event_id", a.EventID, "channel_id", a.ChannelID, "kind", a.Notification}
	var cancel *river.JobCancelError
	switch {
	case err == nil && sent:
		w.notifier.logger.InfoContext(ctx, "alerts: notification delivered", attrs...)
	case err == nil:
		w.notifier.logger.InfoContext(ctx, "alerts: notification skipped; event or channel no longer exists", attrs...)
	case errors.As(err, &cancel):
		w.notifier.logger.ErrorContext(ctx, "alerts: notification dropped; not retrying", append(attrs, "error", err)...)
	case job.Attempt >= job.MaxAttempts:
		w.notifier.logger.ErrorContext(ctx, "alerts: notification failed; giving up", append(attrs, "attempt", job.Attempt, "error", err)...)
	default:
		w.notifier.logger.WarnContext(ctx, "alerts: notification failed; will retry", append(attrs, "attempt", job.Attempt, "error", err)...)
	}
	return err
}

var (
	_ river.Worker[NotifyArgs]  = (*NotifyWorker)(nil)
	_ river.Worker[DeliverArgs] = (*DeliverWorker)(nil)
)
