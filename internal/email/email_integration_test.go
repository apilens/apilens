//go:build integration

package email_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/riverqueue/river"

	"github.com/apilens/apilens/internal/email"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/platform/jobs"
	"github.com/apilens/apilens/internal/testutil"
)

var templates = fstest.MapFS{
	"code.txt.tmpl":  {Data: []byte("{{define \"subject\"}}Your APILens sign-in code{{end}}Your code is {{.code}}.\n")},
	"code.html.tmpl": {Data: []byte(`<p>Your code is <strong>{{.code}}</strong>.</p>`)},
}

type mailpitSummary struct {
	ID        string `json:"ID"`
	MessageID string `json:"MessageID"`
}

type mailpitMessage struct {
	MessageID string
	Subject   string
	Text      string
	HTML      string
	From      struct{ Name, Address string }
	To        []struct{ Name, Address string }
	ReplyTo   []struct{ Name, Address string }
}

func getJSON(t *testing.T, url string, v any) {
	t.Helper()
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET %s: %s", url, resp.Status)
	}
	if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
		t.Fatal(err)
	}
}

// waitForMessage polls Mailpit until exactly one message has arrived.
func waitForMessage(t *testing.T, mp testutil.Mailpit) mailpitSummary {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for {
		var list struct {
			Messages []mailpitSummary `json:"messages"`
		}
		getJSON(t, mp.APIURL+"/messages", &list)
		if len(list.Messages) == 1 {
			return list.Messages[0]
		}
		if len(list.Messages) > 1 || time.Now().After(deadline) {
			t.Fatalf("mailpit has %d messages, want 1", len(list.Messages))
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// TestSendThroughMailpit enqueues an email.send job, works it with the SMTP
// provider and checks what Mailpit received.
func TestSendThroughMailpit(t *testing.T) {
	ctx := context.Background()
	mp := testutil.StartMailpit(t)
	pool := testutil.MigratedPostgres(t)
	logger := testutil.Logger(t)

	sender, err := email.NewSender(config.EmailConfig{
		Provider: config.EmailProviderSMTP, Host: mp.SMTPHost, Port: mp.SMTPPort,
		From: "APILens <no-reply@apilens.test>", ReplyTo: "support@apilens.test",
		TLS: config.EmailTLSNone, Timeout: 10 * time.Second,
	}, logger)
	if err != nil {
		t.Fatal(err)
	}
	renderer, err := email.NewRenderer(templates)
	if err != nil {
		t.Fatal(err)
	}
	promReg := prometheus.NewRegistry()
	metrics := email.NewMetrics(promReg)
	reg := jobs.NewRegistry()
	jobs.Register(reg, email.NewWorker(renderer, sender, logger, metrics))
	client, err := jobs.New(pool, config.JobsConfig{Enabled: true, MaxWorkers: 2, MetricsInterval: time.Second}, reg, 10*time.Second, logger, nil)
	if err != nil {
		t.Fatal(err)
	}

	completed, cancelSub := client.River().Subscribe(river.EventKindJobCompleted, river.EventKindJobFailed, river.EventKindJobCancelled)
	defer cancelSub()
	runCtx, stop := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() { done <- client.Run(runCtx) }()
	defer func() {
		stop()
		if err := <-done; err != nil {
			t.Error(err)
		}
	}()

	res, err := client.Insert(ctx, email.SendArgs{To: "Ada <ada@example.com>", Template: "code", Data: map[string]any{"code": "482913"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.Job.MaxAttempts != 1+email.MaxRetries {
		t.Errorf("max attempts = %d", res.Job.MaxAttempts)
	}
	select {
	case ev := <-completed:
		if ev.Kind != river.EventKindJobCompleted {
			t.Fatalf("job %s: %v", ev.Kind, ev.Job.Errors)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("job did not finish")
	}

	summary := waitForMessage(t, mp)
	var msg mailpitMessage
	getJSON(t, mp.APIURL+"/message/"+summary.ID, &msg)
	if msg.Subject != "Your APILens sign-in code" {
		t.Errorf("subject = %q", msg.Subject)
	}
	if msg.From.Address != "no-reply@apilens.test" || msg.From.Name != "APILens" {
		t.Errorf("from = %+v", msg.From)
	}
	if len(msg.To) != 1 || msg.To[0].Address != "ada@example.com" {
		t.Errorf("to = %+v", msg.To)
	}
	if len(msg.ReplyTo) != 1 || msg.ReplyTo[0].Address != "support@apilens.test" {
		t.Errorf("reply-to = %+v", msg.ReplyTo)
	}
	if strings.TrimSpace(msg.Text) != "Your code is 482913." {
		t.Errorf("text part = %q", msg.Text)
	}
	if !strings.Contains(msg.HTML, "<strong>482913</strong>") {
		t.Errorf("html part = %q", msg.HTML)
	}
	if !strings.HasSuffix(msg.MessageID, "@apilens.test") {
		t.Errorf("message id = %q", msg.MessageID)
	}

	var headers map[string][]string
	getJSON(t, mp.APIURL+"/message/"+summary.ID+"/headers", &headers)
	want := map[string]string{
		"Message-Id":     fmt.Sprintf("<%s>", msg.MessageID),
		"Auto-Submitted": "auto-generated",
		"X-Mailer":       "APILens",
		"Mime-Version":   "1.0",
	}
	for k, v := range want {
		if got := header(headers, k); got != v {
			t.Errorf("header %s = %q, want %q", k, got, v)
		}
	}
	if ct := header(headers, "Content-Type"); !strings.HasPrefix(ct, "multipart/alternative") {
		t.Errorf("content-type = %q", ct)
	}
	if header(headers, "Date") == "" {
		t.Error("no Date header")
	}

	if got := sentTotal(t, promReg, "code", email.StatusSent); got != 1 {
		t.Errorf("apilens_email_sent_total{template=code,status=sent} = %v", got)
	}
}

// header looks a header up case-insensitively.
func header(h map[string][]string, name string) string {
	for k, v := range h {
		if strings.EqualFold(k, name) && len(v) > 0 {
			return v[0]
		}
	}
	return ""
}

func sentTotal(t *testing.T, reg *prometheus.Registry, template, status string) float64 {
	t.Helper()
	mfs, err := reg.Gather()
	if err != nil {
		t.Fatal(err)
	}
	for _, mf := range mfs {
		if mf.GetName() != "apilens_email_sent_total" {
			continue
		}
		for _, m := range mf.GetMetric() {
			labels := map[string]string{}
			for _, l := range m.GetLabel() {
				labels[l.GetName()] = l.GetValue()
			}
			if labels["template"] == template && labels["status"] == status {
				return m.GetCounter().GetValue()
			}
		}
	}
	t.Fatalf("no apilens_email_sent_total{template=%q,status=%q}", template, status)
	return 0
}
