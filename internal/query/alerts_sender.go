package query

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/alerts"
	"github.com/apilens/apilens/internal/email"
)

// TestSender sends test notifications the way the alerts.deliver job sends
// real ones: email is queued as email.send jobs, Slack, Teams and webhooks
// are posted with an alerts.Poster (which refuses non-public addresses).
type TestSender struct {
	pool   AlertPool
	jobs   ExportJobs
	poster *alerts.Poster
	uiURL  string
	now    func() time.Time
}

// NewTestSender returns a TestSender. jobs inserts the email.send jobs in a
// transaction of pool; poster nil is alerts.NewPoster(alerts.PosterOptions{});
// uiURL (identity.public_ui_url) is where the notification links.
func NewTestSender(pool AlertPool, jobs ExportJobs, poster *alerts.Poster, uiURL string) *TestSender {
	if poster == nil {
		poster = alerts.NewPoster(alerts.PosterOptions{})
	}
	return &TestSender{pool: pool, jobs: jobs, poster: poster, uiURL: uiURL, now: time.Now}
}

// TestNotificationFor is the notification a test sends: a triggered sample
// rule, so every channel shows the layout real alerts use.
func TestNotificationFor(n TestNotification, uiURL string, now time.Time) alerts.Notification {
	value := 0.12
	return alerts.Notification{
		Kind: alerts.NotifyTriggered, EventID: uuid.Nil, RuleName: "Test notification from APILens",
		ProjectSlug: n.ProjectSlug, AppName: "Example app", Environment: "test",
		Metric: alerts.MetricErrorRate, Condition: alerts.ConditionGT, Threshold: 0.05, WindowS: 300,
		Value: &value, StartedAt: now.UTC(),
		URL: strings.TrimSuffix(uiURL, "/") + "/" + url.PathEscape(n.ProjectSlug) + "/incidents",
	}
}

// SendTest implements ChannelTester.
func (t *TestSender) SendTest(ctx context.Context, n TestNotification) error {
	cfg, err := alerts.ParseChannelConfig(n.Type, n.Config)
	if err != nil {
		return err
	}
	note := TestNotificationFor(n, t.uiURL, t.now())
	if n.Type != alerts.ChannelEmail {
		return t.poster.Post(ctx, cfg, note, uuid.NewString())
	}
	return pgx.BeginFunc(ctx, t.pool, func(tx pgx.Tx) error {
		for _, to := range cfg.Email.Addresses {
			if _, err := t.jobs.InsertTx(ctx, tx, email.SendArgs{To: to, Template: note.EmailTemplate(), Data: note.EmailData()}, nil); err != nil {
				return fmt.Errorf("query: enqueue test email: %w", err)
			}
		}
		return nil
	})
}
