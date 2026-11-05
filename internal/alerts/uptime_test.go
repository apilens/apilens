package alerts

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/email"
)

func TestIsDown(t *testing.T) {
	now := time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC)
	for gap, want := range map[time.Duration]bool{
		0:                                 false,
		HeartbeatInterval:                 false,
		2*HeartbeatInterval + time.Second: false,
		UptimeDownAfter:                   false, // three intervals exactly: not yet
		UptimeDownAfter + time.Second:     true,
		time.Hour:                         true,
	} {
		if got := IsDown(now.Add(-gap), now); got != want {
			t.Errorf("gap %s: down = %v, want %v", gap, got, want)
		}
	}
}

func TestUptimeStep(t *testing.T) {
	t0 := time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC)
	minute := func(m int) time.Time { return t0.Add(time.Duration(m) * time.Minute) }
	never := UptimeState{Status: UptimeUp, Since: t0}
	up := UptimeState{Status: UptimeUp, Since: t0, Checked: true}
	down := UptimeState{Status: UptimeDown, Since: t0, Checked: true}
	for _, c := range []struct {
		name     string
		prev     UptimeState
		lastSeen time.Time
		now      time.Time
		want     UptimeState
		action   Action
	}{
		{"first check, reporting", never, minute(0), minute(1), UptimeState{UptimeUp, minute(1), true}, ActionNone},
		// Never seen up: no event for a gap that predates monitoring.
		{"first check, already silent", never, minute(0), minute(10), UptimeState{UptimeDown, minute(0), true}, ActionNone},
		{"up, reporting", up, minute(5), minute(6), up, ActionNone},
		{"up, two missed heartbeats", up, minute(5), minute(7), up, ActionNone},
		{"up, gap: down since the last heartbeat", up, minute(5), minute(9), UptimeState{UptimeDown, minute(5), true}, ActionTrigger},
		{"down, still silent", down, minute(0), minute(30), down, ActionNone},
		{"down, reporting again: resolved at that heartbeat", down, minute(29), minute(30), UptimeState{UptimeUp, minute(29), true}, ActionResolve},
		{"unknown status is up", UptimeState{Status: "paused", Since: t0, Checked: true}, minute(5), minute(6), UptimeState{UptimeUp, minute(6), true}, ActionNone},
	} {
		got, action := UptimeStep(c.prev, c.lastSeen, c.now)
		if got != c.want || action != c.action {
			t.Errorf("%s: %+v %v, want %+v %v", c.name, got, action, c.want, c.action)
		}
	}
}

// fakeUptimeTx is an in-memory UptimeTxStore.
type fakeUptimeTx struct {
	monitor *db.UptimeMonitor
	events  []db.AlertEvent
	failAt  string
}

func (f *fakeUptimeTx) EnsureUptimeMonitor(_ context.Context, a db.EnsureUptimeMonitorParams) (db.UptimeMonitor, error) {
	if f.monitor == nil {
		f.monitor = &db.UptimeMonitor{AppID: a.AppID, Environment: a.Environment, ProjectID: a.ProjectID, Status: "up"}
	}
	return *f.monitor, nil
}

func (f *fakeUptimeTx) UpdateUptimeMonitorStatus(_ context.Context, a db.UpdateUptimeMonitorStatusParams) error {
	if f.failAt == "update" {
		return errors.New("boom")
	}
	at := a.CheckedAt
	f.monitor.Status, f.monitor.StatusSince, f.monitor.CheckedAt = a.Status, a.StatusSince, &at
	return nil
}

func (f *fakeUptimeTx) GetOpenUptimeEvent(_ context.Context, a db.GetOpenUptimeEventParams) (db.AlertEvent, error) {
	for _, e := range f.events {
		if *e.MonitorAppID == a.AppID && *e.MonitorEnvironment == a.Environment && e.State == "triggered" {
			return e, nil
		}
	}
	return db.AlertEvent{}, pgx.ErrNoRows
}

func (f *fakeUptimeTx) OpenUptimeEvent(_ context.Context, a db.OpenUptimeEventParams) (db.AlertEvent, error) {
	app, env := a.AppID, a.Environment
	e := db.AlertEvent{ID: a.ID, Kind: "uptime", MonitorAppID: &app, MonitorEnvironment: &env, State: "triggered", Value: a.Value, StartedAt: a.StartedAt}
	f.events = append(f.events, e)
	return e, nil
}

func (f *fakeUptimeTx) ResolveAlertEvent(_ context.Context, a db.ResolveAlertEventParams) (db.AlertEvent, error) {
	for i, e := range f.events {
		if e.ID == a.ID && e.State == "triggered" {
			end := a.EndedAt
			f.events[i].State, f.events[i].EndedAt = "resolved", &end
			return f.events[i], nil
		}
	}
	return db.AlertEvent{}, pgx.ErrNoRows
}

func TestRecordUptime(t *testing.T) {
	ctx := context.Background()
	t0 := time.Date(2026, 11, 4, 10, 0, 30, 0, time.UTC)
	at := func(m int) time.Time { return t0.Add(time.Duration(m) * time.Minute) }
	target := func(lastSeen time.Time) UptimeTarget {
		return UptimeTarget{ProjectID: testProjectID, AppID: testAppID, Environment: "production", LastSeenAt: lastSeen}
	}

	t.Run("SDK stops: down within four minutes, then up again", func(t *testing.T) {
		f := &fakeUptimeTx{}
		// Heartbeats every minute until minute 2, then the SDK stops.
		var opened time.Time
		for m := 0; m <= 8; m++ {
			last := at(min(m, 2))
			tr, err := recordUptime(ctx, f, target(last), at(m).Add(10*time.Second))
			if err != nil {
				t.Fatal(err)
			}
			if tr.Action == ActionTrigger {
				opened = at(m).Add(10 * time.Second)
			}
		}
		if len(f.events) != 1 {
			t.Fatalf("events = %d, want 1", len(f.events))
		}
		e := f.events[0]
		if !e.StartedAt.Equal(at(2)) || e.State != "triggered" {
			t.Errorf("event = %+v", e)
		}
		if gap := opened.Sub(at(2)); gap > 4*time.Minute {
			t.Errorf("down reported %s after the last heartbeat, want within 4m", gap)
		}
		if e.Value < UptimeDownAfter.Seconds() {
			t.Errorf("value = %v, want the seconds since the last heartbeat", e.Value)
		}
		tr, err := recordUptime(ctx, f, target(at(20)), at(20).Add(5*time.Second))
		if err != nil || tr.Action != ActionResolve || tr.Event == nil {
			t.Fatalf("back up: %+v, %v", tr, err)
		}
		if f.events[0].State != "resolved" || !f.events[0].EndedAt.Equal(at(20)) {
			t.Errorf("resolved event = %+v", f.events[0])
		}
		if f.monitor.Status != "up" || !f.monitor.StatusSince.Equal(at(20)) {
			t.Errorf("monitor = %+v", f.monitor)
		}
	})

	t.Run("retried check changes nothing", func(t *testing.T) {
		f := &fakeUptimeTx{}
		if _, err := recordUptime(ctx, f, target(at(0)), at(1)); err != nil {
			t.Fatal(err)
		}
		if _, err := recordUptime(ctx, f, target(at(0)), at(5)); err != nil {
			t.Fatal(err)
		}
		tr, err := recordUptime(ctx, f, target(at(0)), at(5))
		if err != nil || !tr.Replayed || tr.Event != nil || len(f.events) != 1 {
			t.Errorf("retry: %+v, %v, events %d", tr, err, len(f.events))
		}
	})

	t.Run("mute is reported, the event still recorded", func(t *testing.T) {
		f := &fakeUptimeTx{monitor: &db.UptimeMonitor{AppID: testAppID, Environment: "production", Status: "up", Muted: true}}
		if _, err := recordUptime(ctx, f, target(at(0)), at(1)); err != nil {
			t.Fatal(err)
		}
		tr, err := recordUptime(ctx, f, target(at(0)), at(5))
		if err != nil || tr.Action != ActionTrigger || !tr.Muted || len(f.events) != 1 {
			t.Errorf("muted: %+v, %v, events %d", tr, err, len(f.events))
		}
	})

	t.Run("an open event is reused", func(t *testing.T) {
		app, env := testAppID, "production"
		open := db.AlertEvent{ID: uuid.New(), Kind: "uptime", MonitorAppID: &app, MonitorEnvironment: &env, State: "triggered", StartedAt: at(0)}
		checked := at(1)
		f := &fakeUptimeTx{
			monitor: &db.UptimeMonitor{AppID: app, Environment: env, Status: "up", StatusSince: at(0), CheckedAt: &checked},
			events:  []db.AlertEvent{open},
		}
		tr, err := recordUptime(ctx, f, target(at(0)), at(5))
		if err != nil || tr.Event == nil || tr.Event.ID != open.ID || len(f.events) != 1 {
			t.Errorf("trigger with open event: %+v, %v", tr, err)
		}
	})

	t.Run("failed write returns an error", func(t *testing.T) {
		f := &fakeUptimeTx{failAt: "update"}
		if _, err := recordUptime(ctx, f, target(at(0)), at(1)); err == nil {
			t.Error("no error")
		}
	})
}

// uptimeRow is the GetUptimeEventNotification row of the sample uptime
// event, open or resolved.
func uptimeRow(kind NotificationKind, channels ...uuid.UUID) db.GetUptimeEventNotificationRow {
	row := db.GetUptimeEventNotificationRow{
		ID: testEventID, State: "triggered", Value: 212, StartedAt: testStart,
		Environment: "production", ProjectID: testProjectID, AppID: testAppID, AppName: "storefront",
		ProjectSlug: "shop", ChannelIds: channels,
	}
	if kind == NotifyResolved {
		row.State = "resolved"
		end := testEnd
		row.EndedAt = &end
	}
	return row
}

func TestUptimeNotificationText(t *testing.T) {
	n := UptimeNotificationFromRow(NotifyTriggered, uptimeRow(NotifyTriggered), testUIURL)
	if got, want := n.Title(), "Down: storefront (production)"; got != want {
		t.Errorf("title = %q, want %q", got, want)
	}
	if got, want := n.Summary(), "storefront (production) has sent no heartbeat for over 3 minutes."; got != want {
		t.Errorf("summary = %q, want %q", got, want)
	}
	if n.URL != "https://app.example.com/shop/incidents?event="+testEventID.String() {
		t.Errorf("URL = %s", n.URL)
	}
	r := UptimeNotificationFromRow(NotifyResolved, uptimeRow(NotifyResolved), testUIURL)
	if r.Title() != "Up again: storefront (production)" || r.Summary() != "storefront (production) is sending heartbeats again." {
		t.Errorf("resolved = %q / %q", r.Title(), r.Summary())
	}
	if r.WebhookEventType() != "uptime.up" || n.WebhookEventType() != "uptime.down" {
		t.Errorf("webhook types = %s, %s", n.WebhookEventType(), r.WebhookEventType())
	}
	// No rule fields leak into an uptime notification.
	for _, nn := range []Notification{n, r} {
		for _, f := range nn.facts() {
			if f.title == "Metric" || f.title == "Threshold" || f.title == "Window" {
				t.Errorf("uptime fact %q", f.title)
			}
		}
	}
	b, err := n.WebhookPayload()
	if err != nil {
		t.Fatal(err)
	}
	var body map[string]any
	if err := json.Unmarshal(b, &body); err != nil {
		t.Fatal(err)
	}
	if _, ok := body["rule"]; ok {
		t.Errorf("uptime webhook has a rule: %s", b)
	}
	if ev := body["event"].(map[string]any); ev["kind"] != "uptime" {
		t.Errorf("event = %v", ev)
	}
}

// TestUptimeChannelContracts records every channel's uptime payloads in
// testdata/notify, as TestChannelContracts does for a rule's events.
func TestUptimeChannelContracts(t *testing.T) {
	for _, typ := range []ChannelType{ChannelSlack, ChannelTeams, ChannelWebhook} {
		for _, kind := range []NotificationKind{NotifyTriggered, NotifyResolved} {
			t.Run(string(typ)+"_"+string(kind), func(t *testing.T) {
				srv := newRecorder(t)
				h := newHarness(t, srv.Client())
				config := `{"webhook_url":"` + srv.URL + `/services/T000/B000/XXXX"}`
				if typ == ChannelWebhook {
					config = `{"url":"` + srv.URL + `/hooks/apilens","secret":"whsec_0123456789abcdef"}`
				}
				ch := h.addChannel(t, typ, config)
				h.store.uptime[testEventID] = uptimeRow(kind, ch)
				if err := h.work(DeliverArgs{EventID: testEventID, ChannelID: ch, Notification: kind}, 1); err != nil {
					t.Fatal(err)
				}
				reqs := srv.requests()
				if len(reqs) != 1 {
					t.Fatalf("requests = %d, want 1", len(reqs))
				}
				checkGolden(t, "uptime_"+string(typ)+"_"+string(kind)+".json", reqs[0])
			})
		}
	}
}

func TestUptimeEmailContract(t *testing.T) {
	renderer, err := email.DefaultRenderer(email.WithPublicUIURL(testUIURL))
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []NotificationKind{NotifyTriggered, NotifyResolved} {
		t.Run(string(kind), func(t *testing.T) {
			h := newHarness(t, nil)
			ch := h.addChannel(t, ChannelEmail, `{"addresses":["oncall@example.com"]}`)
			h.store.uptime[testEventID] = uptimeRow(kind, ch)
			if err := h.work(DeliverArgs{EventID: testEventID, ChannelID: ch, Notification: kind}, 1); err != nil {
				t.Fatal(err)
			}
			jobs := h.jobs.inserted()
			if len(jobs) != 1 {
				t.Fatalf("jobs = %d, want 1", len(jobs))
			}
			a := jobs[0].(email.SendArgs)
			b, _ := json.Marshal(a)
			var stored email.SendArgs
			if err := json.Unmarshal(b, &stored); err != nil {
				t.Fatal(err)
			}
			msg, err := renderer.Render(stored.Template, stored.To, stored.Data)
			if err != nil {
				t.Fatalf("render %s: %v", stored.Template, err)
			}
			if !strings.Contains(msg.Text, "storefront (production)") {
				t.Errorf("email:\n%s", msg.Text)
			}
			checkGolden(t, "uptime_email_"+string(kind)+".json", jobs)
		})
	}
}

// TestUptimeMuteSuppressesNotifications: a muted environment's events fan
// out to no channel, and a delivery already queued when it was muted sends
// nothing.
func TestUptimeMuteSuppressesNotifications(t *testing.T) {
	h := newHarness(t, nil)
	mail := h.addChannel(t, ChannelEmail, `{"addresses":["oncall@example.com"]}`)
	slack := h.addChannel(t, ChannelSlack, `{"webhook_url":"https://hooks.slack.com/services/T/B/X"}`)
	row := uptimeRow(NotifyTriggered, mail, slack)
	h.store.uptime[testEventID] = row
	ctx := context.Background()
	n, err := h.n.FanOut(ctx, NotifyArgs{EventID: testEventID, Notification: NotifyTriggered})
	if err != nil || n != 2 {
		t.Fatalf("unmuted FanOut = %d, %v; want 2", n, err)
	}

	row.Muted = true
	h.store.uptime[testEventID] = row
	h.jobs = &fakeJobs{}
	h.n.jobs = h.jobs
	if n, err := h.n.FanOut(ctx, NotifyArgs{EventID: testEventID, Notification: NotifyTriggered}); err != nil || n != 0 {
		t.Errorf("muted FanOut = %d, %v; want 0", n, err)
	}
	if sent, err := h.n.Deliver(ctx, DeliverArgs{EventID: testEventID, ChannelID: mail, Notification: NotifyTriggered}); sent || err != nil {
		t.Errorf("muted Deliver = %v, %v", sent, err)
	}
	if got := len(h.jobs.inserted()); got != 0 {
		t.Errorf("jobs = %d, want 0", got)
	}
}
