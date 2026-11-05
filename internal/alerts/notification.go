package alerts

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/email"
)

// NotificationKind is what a notification announces.
type NotificationKind string

// The notifications an event sends: one when it triggers, one when it
// resolves.
const (
	NotifyTriggered NotificationKind = "triggered"
	NotifyResolved  NotificationKind = "resolved"
)

// Valid reports whether k is a known kind.
func (k NotificationKind) Valid() bool { return k == NotifyTriggered || k == NotifyResolved }

// Notification is what every channel says about an alert event. Value is
// the metric value that triggered the event, or for a resolved event the
// latest evaluated value (nil when the window had no data). For a
// triggered uptime event it is the seconds since the last heartbeat; a
// resolved one has none.
type Notification struct {
	Kind        NotificationKind
	EventID     uuid.UUID
	RuleID      uuid.UUID
	RuleName    string
	ProjectSlug string
	AppID       uuid.UUID
	AppName     string
	Environment string
	Metric      Metric
	Condition   Condition
	Threshold   float64
	WindowS     int32
	Value       *float64
	StartedAt   time.Time
	EndedAt     *time.Time
	// URL is the incident's page in the UI.
	URL string
	// Uptime is set for an uptime event, which has no rule: the rule,
	// metric, condition, threshold and window fields are empty.
	Uptime *UptimeDetails
}

// UptimeDetails is what an uptime notification says beyond the app and
// environment.
type UptimeDetails struct {
	// LastHeartbeat is the last heartbeat before the gap (the event's
	// started_at).
	LastHeartbeat time.Time
	// DownAfter is how long the environment went without a heartbeat
	// before it counted as down.
	DownAfter time.Duration
}

// UptimeNotificationFromRow builds the notification of kind about the
// uptime event in row. The deep link is the same incidents page as a
// rule's events.
func UptimeNotificationFromRow(kind NotificationKind, row db.GetUptimeEventNotificationRow, uiURL string) Notification {
	n := Notification{
		Kind: kind, EventID: row.ID, ProjectSlug: row.ProjectSlug, AppID: row.AppID, AppName: row.AppName,
		Environment: row.Environment, StartedAt: row.StartedAt.UTC(),
		Uptime: &UptimeDetails{LastHeartbeat: row.StartedAt.UTC(), DownAfter: UptimeDownAfter},
	}
	if kind == NotifyTriggered {
		v := row.Value
		n.Value = &v
	} else if row.EndedAt != nil {
		t := row.EndedAt.UTC()
		n.EndedAt = &t
	}
	n.URL = IncidentURL(uiURL, row.ProjectSlug, row.ID)
	return n
}

// formatDuration formats a duration of whole seconds for people: "3
// minutes", "1 hour".
func formatDuration(d time.Duration) string { return FormatWindow(int32(d / time.Second)) }

// scope is the app and environment for people: "storefront (production)".
func (n Notification) scope() string { return n.AppName + " (" + n.Environment + ")" }

// NotificationFromRow builds the notification of kind about the event in
// row. uiURL is identity.public_ui_url; the deep link is
// <uiURL>/<project>/incidents?event=<id>.
func NotificationFromRow(kind NotificationKind, row db.GetAlertEventNotificationRow, uiURL string) Notification {
	n := Notification{
		Kind: kind, EventID: row.ID, RuleID: row.RuleID, RuleName: row.RuleName,
		ProjectSlug: row.ProjectSlug, AppID: row.AppID, AppName: row.AppName, Environment: row.Environment,
		Metric: Metric(row.Metric), Condition: Condition(row.Condition), Threshold: row.Threshold,
		WindowS: row.WindowS, StartedAt: row.StartedAt.UTC(),
	}
	if kind == NotifyTriggered {
		v := row.Value
		n.Value = &v
	} else {
		n.Value = row.LatestValue
		if row.EndedAt != nil {
			t := row.EndedAt.UTC()
			n.EndedAt = &t
		}
	}
	n.URL = IncidentURL(uiURL, row.ProjectSlug, row.ID)
	return n
}

// IncidentURL is the UI page of an event.
func IncidentURL(uiURL, projectSlug string, event uuid.UUID) string {
	return strings.TrimSuffix(uiURL, "/") + "/" + url.PathEscape(projectSlug) + "/incidents?" +
		url.Values{"event": {event.String()}}.Encode()
}

// metricLabels are the metrics' display names.
var metricLabels = map[Metric]string{
	MetricTraffic:         "Traffic",
	MetricErrors:          "Errors",
	MetricErrorRate:       "Error rate",
	MetricP50:             "p50 response time",
	MetricP75:             "p75 response time",
	MetricP95:             "p95 response time",
	MetricApdex:           "Apdex",
	MetricUniqueConsumers: "Unique consumers",
}

// Label is the metric's display name.
func (m Metric) Label() string {
	if l, ok := metricLabels[m]; ok {
		return l
	}
	return string(m)
}

// Symbol is the condition as a comparison sign.
func (c Condition) Symbol() string {
	switch c {
	case ConditionGT:
		return ">"
	case ConditionGTE:
		return "≥"
	case ConditionLT:
		return "<"
	case ConditionLTE:
		return "≤"
	}
	return string(c)
}

// FormatValue formats a value of metric m for people: error rate as a
// percentage, response times in ms, Apdex with two decimals, counts as
// integers. nil is "no data".
func FormatValue(m Metric, v *float64) string {
	if v == nil {
		return "no data"
	}
	x := *v
	switch m {
	case MetricErrorRate:
		return trimFloat(x*100, 2) + "%"
	case MetricP50, MetricP75, MetricP95:
		return trimFloat(x, 1) + " ms"
	case MetricApdex:
		return strconv.FormatFloat(x, 'f', 2, 64)
	default:
		return trimFloat(x, 2)
	}
}

func trimFloat(x float64, prec int) string {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return strconv.FormatFloat(x, 'f', -1, 64)
	}
	s := strconv.FormatFloat(x, 'f', prec, 64)
	if strings.Contains(s, ".") {
		s = strings.TrimRight(strings.TrimRight(s, "0"), ".")
	}
	return s
}

// FormatWindow formats a window length: "90 seconds", "5 minutes", "1 hour".
func FormatWindow(s int32) string {
	plural := func(n int32, unit string) string {
		if n == 1 {
			return "1 " + unit
		}
		return fmt.Sprintf("%d %ss", n, unit)
	}
	switch {
	case s > 0 && s%3600 == 0:
		return plural(s/3600, "hour")
	case s > 0 && s%60 == 0:
		return plural(s/60, "minute")
	default:
		return plural(s, "second")
	}
}

// ValueText is the notification's value for people.
func (n Notification) ValueText() string { return FormatValue(n.Metric, n.Value) }

// ThresholdText is the rule's condition for people, for example "> 5%".
func (n Notification) ThresholdText() string {
	t := n.Threshold
	return n.Condition.Symbol() + " " + FormatValue(n.Metric, &t)
}

// Title is the one-line summary every channel leads with.
func (n Notification) Title() string {
	if n.Uptime != nil {
		if n.Kind == NotifyResolved {
			return "Up again: " + n.scope()
		}
		return "Down: " + n.scope()
	}
	if n.Kind == NotifyResolved {
		return "Resolved: " + n.RuleName
	}
	return "Triggered: " + n.RuleName
}

// Summary is one sentence on what happened.
func (n Notification) Summary() string {
	scope := n.scope()
	if n.Uptime != nil {
		if n.Kind == NotifyResolved {
			return scope + " is sending heartbeats again."
		}
		return fmt.Sprintf("%s has sent no heartbeat for over %s.", scope, formatDuration(n.Uptime.DownAfter))
	}
	window := FormatWindow(n.WindowS)
	if n.Kind == NotifyResolved {
		return fmt.Sprintf("%s on %s is no longer %s over the last %s.", n.Metric.Label(), scope, n.ThresholdText(), window)
	}
	return fmt.Sprintf("%s on %s is %s, %s over the last %s.", n.Metric.Label(), scope, n.ValueText(), n.ThresholdText(), window)
}

// fact is one labelled value of a notification.
type fact struct{ title, value string }

func (n Notification) facts() []fact {
	if n.Uptime != nil {
		f := []fact{
			{"App", n.AppName},
			{"Environment", n.Environment},
			{"Check", "Heartbeat"},
			{"Last heartbeat", n.Uptime.LastHeartbeat.Format(time.RFC1123)},
			{"Down after", formatDuration(n.Uptime.DownAfter) + " without a heartbeat"},
			{"Started", n.StartedAt.Format(time.RFC1123)},
		}
		if n.EndedAt != nil {
			f = append(f, fact{"Resolved", n.EndedAt.Format(time.RFC1123)})
		}
		return f
	}
	valueTitle := "Value"
	if n.Kind == NotifyResolved {
		valueTitle = "Latest value"
	}
	f := []fact{
		{"App", n.AppName},
		{"Environment", n.Environment},
		{"Metric", n.Metric.Label()},
		{valueTitle, n.ValueText()},
		{"Threshold", n.ThresholdText()},
		{"Window", FormatWindow(n.WindowS)},
		{"Started", n.StartedAt.Format(time.RFC1123)},
	}
	if n.EndedAt != nil {
		f = append(f, fact{"Resolved", n.EndedAt.Format(time.RFC1123)})
	}
	return f
}

// EmailTemplate is the email.send template for the notification.
func (n Notification) EmailTemplate() string {
	if n.Uptime != nil {
		if n.Kind == NotifyResolved {
			return email.TemplateUptimeUp
		}
		return email.TemplateUptimeDown
	}
	if n.Kind == NotifyResolved {
		return email.TemplateAlertResolved
	}
	return email.TemplateAlertTriggered
}

// EmailData is the email.send job data for the notification's template.
// The template builds the link from project and event, so the job carries
// no URL.
func (n Notification) EmailData() map[string]any {
	if n.Uptime != nil {
		d := map[string]any{
			"app":         n.AppName,
			"environment": n.Environment,
			"project":     n.ProjectSlug,
			"event":       n.EventID.String(),
		}
		if n.Kind == NotifyResolved {
			ended := n.StartedAt
			if n.EndedAt != nil {
				ended = *n.EndedAt
			}
			d["started_at"] = n.StartedAt.Format(time.RFC3339)
			d["ended_at"] = ended.Format(time.RFC3339)
		} else {
			d["last_heartbeat"] = n.Uptime.LastHeartbeat.Format(time.RFC3339)
			d["down_after"] = formatDuration(n.Uptime.DownAfter)
		}
		return d
	}
	d := map[string]any{
		"rule":        n.RuleName,
		"app":         n.AppName,
		"environment": n.Environment,
		"metric":      n.Metric.Label(),
		"value":       n.ValueText(),
		"threshold":   n.ThresholdText(),
		"window":      FormatWindow(n.WindowS),
		"started_at":  n.StartedAt.Format(time.RFC3339),
		"project":     n.ProjectSlug,
		"event":       n.EventID.String(),
	}
	if n.Kind == NotifyResolved {
		ended := n.StartedAt
		if n.EndedAt != nil {
			ended = *n.EndedAt
		}
		d["ended_at"] = ended.Format(time.RFC3339)
	}
	return d
}

// SlackPayload is the Block Kit message posted to a Slack incoming webhook.
// text is the fallback shown in notifications.
func (n Notification) SlackPayload() ([]byte, error) {
	emoji := ":rotating_light:"
	if n.Kind == NotifyResolved {
		emoji = ":white_check_mark:"
	}
	fields := []map[string]any{}
	for _, f := range n.facts() {
		if f.title == "Started" || f.title == "Resolved" {
			continue
		}
		fields = append(fields, map[string]any{"type": "mrkdwn", "text": "*" + f.title + "*\n" + slackEscape(f.value)})
	}
	context := "Started " + slackDate(n.StartedAt)
	if n.EndedAt != nil {
		context += " · Resolved " + slackDate(*n.EndedAt)
	}
	msg := map[string]any{
		"text": slackEscape(n.Title() + " — " + n.Summary()),
		"blocks": []map[string]any{
			{"type": "header", "text": map[string]any{"type": "plain_text", "text": truncate(n.Title(), 150), "emoji": true}},
			{"type": "section", "text": map[string]any{"type": "mrkdwn", "text": emoji + " " + slackEscape(n.Summary())}},
			{"type": "section", "fields": fields},
			{"type": "context", "elements": []map[string]any{{"type": "mrkdwn", "text": context}}},
			{"type": "actions", "elements": []map[string]any{{
				"type": "button", "text": map[string]any{"type": "plain_text", "text": "View incident"},
				"url": n.URL, "action_id": "view_incident",
			}}},
		},
	}
	return marshalJSON(msg)
}

// marshalJSON encodes v without HTML escaping (<, >, & stay as they are,
// which Slack and Teams render literally).
func marshalJSON(v any) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(b.Bytes(), []byte("\n")), nil
}

// slackDate renders t in the reader's time zone, with a UTC fallback.
func slackDate(t time.Time) string {
	return fmt.Sprintf("<!date^%d^{date_short_pretty} {time}|%s>", t.Unix(), t.Format("2 Jan 2006 15:04 UTC"))
}

// slackEscape escapes the characters Slack's mrkdwn treats as control
// characters.
func slackEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s)
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}

// TeamsPayload is the Adaptive Card message posted to a Microsoft Teams
// incoming webhook (Workflows "post to a channel when a webhook request is
// received", or a legacy connector).
func (n Notification) TeamsPayload() ([]byte, error) {
	color := "Attention"
	if n.Kind == NotifyResolved {
		color = "Good"
	}
	nf := n.facts()
	facts := make([]map[string]any, 0, len(nf))
	for _, f := range nf {
		facts = append(facts, map[string]any{"title": f.title, "value": f.value})
	}
	card := map[string]any{
		"$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
		"type":    "AdaptiveCard",
		"version": "1.4",
		"msteams": map[string]any{"width": "Full"},
		"body": []map[string]any{
			{"type": "TextBlock", "text": n.Title(), "size": "Large", "weight": "Bolder", "color": color, "wrap": true},
			{"type": "TextBlock", "text": n.Summary(), "wrap": true},
			{"type": "FactSet", "facts": facts},
		},
		"actions": []map[string]any{{"type": "Action.OpenUrl", "title": "View incident", "url": n.URL}},
	}
	msg := map[string]any{
		"type": "message",
		"attachments": []map[string]any{{
			"contentType": "application/vnd.microsoft.card.adaptive",
			"contentUrl":  nil,
			"content":     card,
		}},
	}
	return marshalJSON(msg)
}

// WebhookEvent is the JSON body of a generic webhook delivery.
type WebhookEvent struct {
	// Type is alert.triggered or alert.resolved; uptime.down or uptime.up
	// for an uptime event.
	Type  string    `json:"type"`
	Event webhookEv `json:"event"`
	// Rule is omitted for an uptime event.
	Rule *webhookRl `json:"rule,omitempty"`
	App  webhookAp  `json:"app"`
	// Project is the project's slug.
	Project     string `json:"project"`
	Environment string `json:"environment"`
	URL         string `json:"url"`
	Title       string `json:"title"`
	Summary     string `json:"summary"`
}

type webhookEv struct {
	ID uuid.UUID `json:"id"`
	// Kind is set to uptime for an uptime event; omitted for a rule's.
	Kind      string     `json:"kind,omitempty"`
	State     string     `json:"state"`
	Value     *float64   `json:"value"`
	StartedAt time.Time  `json:"started_at"`
	EndedAt   *time.Time `json:"ended_at"`
}

type webhookRl struct {
	ID        uuid.UUID `json:"id"`
	Name      string    `json:"name"`
	Metric    Metric    `json:"metric"`
	Condition Condition `json:"condition"`
	Threshold float64   `json:"threshold"`
	WindowS   int32     `json:"window_s"`
}

type webhookAp struct {
	ID   uuid.UUID `json:"id"`
	Name string    `json:"name"`
}

// WebhookEventType is the type of the notification's webhook delivery.
func (n Notification) WebhookEventType() string {
	if n.Uptime != nil {
		if n.Kind == NotifyResolved {
			return "uptime.up"
		}
		return "uptime.down"
	}
	return "alert." + string(n.Kind)
}

// WebhookPayload is the JSON body of the generic webhook delivery.
func (n Notification) WebhookPayload() ([]byte, error) {
	state := "triggered"
	if n.Kind == NotifyResolved {
		state = "resolved"
	}
	ev := WebhookEvent{
		Type: n.WebhookEventType(),
		Event: webhookEv{
			ID: n.EventID, State: state, Value: n.Value, StartedAt: n.StartedAt, EndedAt: n.EndedAt,
		},
		App:     webhookAp{ID: n.AppID, Name: n.AppName},
		Project: n.ProjectSlug, Environment: n.Environment, URL: n.URL,
		Title: n.Title(), Summary: n.Summary(),
	}
	if n.Uptime != nil {
		ev.Event.Kind = "uptime"
	} else {
		ev.Rule = &webhookRl{
			ID: n.RuleID, Name: n.RuleName, Metric: n.Metric, Condition: n.Condition,
			Threshold: n.Threshold, WindowS: n.WindowS,
		}
	}
	return marshalJSON(ev)
}
