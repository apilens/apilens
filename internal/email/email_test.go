package email

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	promtest "github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"

	"github.com/apilens/apilens/internal/platform/config"
)

var testTemplates = fstest.MapFS{
	"layout.html.tmpl": {Data: []byte(`{{define "layout"}}<html><body>{{template "content" .}}</body></html>{{end}}`)},
	"code.txt.tmpl":    {Data: []byte("{{define \"subject\"}}Your sign-in code is {{.code}}{{end}}\nYour code is {{.code}}.\n")},
	"code.html.tmpl":   {Data: []byte(`{{template "layout" .}}{{define "content"}}<p>Your code is <b>{{.code}}</b> for {{.name}}</p>{{end}}`)},
	"plain.txt.tmpl": {Data: []byte(`{{define "subject"}}  Plain
 subject {{end}}Hello.`)},
	"README.md": {Data: []byte("ignored")},
}

func testRenderer(t *testing.T) *Renderer {
	t.Helper()
	r, err := NewRenderer(testTemplates)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestDefaultRenderer(t *testing.T) {
	if _, err := DefaultRenderer(); err != nil {
		t.Fatal(err)
	}
}

func TestRender(t *testing.T) {
	r := testRenderer(t)
	if got := r.Names(); strings.Join(got, ",") != "code,plain" {
		t.Fatalf("names = %v", got)
	}
	msg, err := r.Render("code", "a@example.com", map[string]any{"code": "123456", "name": "<Ada>"})
	if err != nil {
		t.Fatal(err)
	}
	if msg.Subject != "Your sign-in code is 123456" || msg.To != "a@example.com" || msg.Template != "code" {
		t.Errorf("msg = %+v", msg)
	}
	if msg.Text != "Your code is 123456.\n" {
		t.Errorf("text = %q", msg.Text)
	}
	if msg.HTML != "<html><body><p>Your code is <b>123456</b> for &lt;Ada&gt;</p></body></html>" {
		t.Errorf("html = %q", msg.HTML)
	}

	plain, err := r.Render("plain", "a@example.com", nil)
	if err != nil {
		t.Fatal(err)
	}
	if plain.Subject != "Plain subject" || plain.HTML != "" || plain.Text != "Hello.\n" {
		t.Errorf("plain = %+v", plain)
	}
}

func TestRenderErrors(t *testing.T) {
	r := testRenderer(t)
	if _, err := r.Render("nope", "a@example.com", nil); !errors.Is(err, ErrUnknownTemplate) {
		t.Errorf("unknown template err = %v", err)
	}
	if _, err := r.Render("code", "a@example.com", map[string]any{"name": "x"}); err == nil {
		t.Error("missing data key rendered without error")
	}
}

func TestNewRendererErrors(t *testing.T) {
	for name, fsys := range map[string]fstest.MapFS{
		"no subject":   {"a.txt.tmpl": {Data: []byte("body")}},
		"html only":    {"a.html.tmpl": {Data: []byte("<p>x</p>")}},
		"syntax error": {"a.txt.tmpl": {Data: []byte(`{{define "subject"}}x{{end}}{{.x`)}},
	} {
		if _, err := NewRenderer(fsys); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
}

func TestLogSender(t *testing.T) {
	var buf bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&buf, nil))
	s, err := NewSender(config.EmailConfig{Provider: config.EmailProviderLog}, logger)
	if err != nil {
		t.Fatal(err)
	}
	msg := &Message{To: "a@example.com", Subject: "Hi", Text: "code 123456\n", HTML: "<p>123456</p>", Template: "code"}
	if err := s.Send(context.Background(), msg); err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(msg.ID, "@localhost") {
		t.Errorf("message id = %q", msg.ID)
	}
	out := buf.String()
	for _, want := range []string{`"to":"a@example.com"`, `"subject":"Hi"`, `"message_id":"` + msg.ID, `code 123456`, `"html":"<p>123456</p>"`, `"template":"code"`} {
		if !strings.Contains(out, want) {
			t.Errorf("log output missing %s:\n%s", want, out)
		}
	}
}

func TestNewSender(t *testing.T) {
	smtp := config.EmailConfig{Provider: config.EmailProviderSMTP, Host: "smtp.example.com", Port: 587,
		From: "APILens <no-reply@mail.example.com>", TLS: config.EmailTLSStartTLS, Timeout: time.Second}
	s, err := NewSender(smtp, slog.Default())
	if err != nil {
		t.Fatal(err)
	}
	if ss, ok := s.(*SMTPSender); !ok || ss.domain != "mail.example.com" {
		t.Errorf("sender = %#v", s)
	}
	if _, err := NewSender(config.EmailConfig{Provider: "sendgrid"}, slog.Default()); err == nil {
		t.Error("unknown provider accepted")
	}
	smtp.From = ""
	if _, err := NewSender(smtp, slog.Default()); err == nil {
		t.Error("smtp without from accepted")
	}
}

func TestSendArgs(t *testing.T) {
	if (SendArgs{}).Kind() != "email.send" {
		t.Error("kind")
	}
	if got := (SendArgs{}).InsertOpts().MaxAttempts; got != 1+MaxRetries {
		t.Errorf("max attempts = %d", got)
	}
}

func TestBackoff(t *testing.T) {
	want := []time.Duration{30 * time.Second, time.Minute, 2 * time.Minute, 4 * time.Minute, 8 * time.Minute, 15 * time.Minute}
	for i, w := range want {
		if got := backoff(i + 1); got != w {
			t.Errorf("attempt %d: %v, want %v", i+1, got, w)
		}
	}
	if backoff(0) != retryBase || backoff(64) != retryMax {
		t.Error("backoff bounds")
	}
}

type fakeSender struct {
	err  error
	sent []*Message
}

func (f *fakeSender) Send(_ context.Context, msg *Message) error {
	msg.ID = "fixed@test"
	if f.err != nil {
		return f.err
	}
	f.sent = append(f.sent, msg)
	return nil
}

func job(args SendArgs, attempt int) *river.Job[SendArgs] {
	return &river.Job[SendArgs]{JobRow: &rivertype.JobRow{ID: 7, Attempt: attempt, MaxAttempts: 1 + MaxRetries}, Args: args}
}

func TestWorker(t *testing.T) {
	var logs bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&logs, nil))
	reg := prometheus.NewRegistry()
	metrics := NewMetrics(reg)
	sender := &fakeSender{}
	w := NewWorker(testRenderer(t), sender, logger, metrics)
	ctx := context.Background()

	if err := w.Work(ctx, job(SendArgs{To: "a@example.com", Template: "code", Data: map[string]any{"code": "111222", "name": "Ada"}}, 1)); err != nil {
		t.Fatal(err)
	}
	if len(sender.sent) != 1 || sender.sent[0].Subject != "Your sign-in code is 111222" {
		t.Fatalf("sent = %+v", sender.sent)
	}

	// Transient failure: retried, logged with message id, never the body.
	sender.err = errors.New("connection refused")
	err := w.Work(ctx, job(SendArgs{To: "a@example.com", Template: "code", Data: map[string]any{"code": "333444", "name": "Ada"}}, 2))
	if err == nil {
		t.Fatal("send failure swallowed")
	}
	var cancel *river.JobCancelError
	if errors.As(err, &cancel) {
		t.Error("send failure cancelled the job; want retry")
	}
	if !strings.Contains(logs.String(), "message_id=fixed@test") || strings.Contains(logs.String(), "333444") {
		t.Errorf("failure log:\n%s", logs.String())
	}

	// Render errors are permanent: cancel, no retry.
	for _, args := range []SendArgs{
		{To: "a@example.com", Template: "nope"},
		{To: "a@example.com", Template: "code"}, // missing data
	} {
		if err := w.Work(ctx, job(args, 1)); !errors.As(err, &cancel) {
			t.Errorf("%s: err = %v, want JobCancel", args.Template, err)
		}
	}

	for _, c := range []struct {
		template, status string
		want             float64
	}{
		{"code", StatusSent, 1},
		{"code", StatusFailed, 1},
		{"code", StatusRejected, 1},
		{"unknown", StatusRejected, 1},
	} {
		if got := promtest.ToFloat64(metrics.sent.WithLabelValues(c.template, c.status)); got != c.want {
			t.Errorf("apilens_email_sent_total{template=%q,status=%q} = %v, want %v", c.template, c.status, got, c.want)
		}
	}
	if n, err := promtest.GatherAndCount(reg, "apilens_email_sent_total"); err != nil || n != 4 {
		t.Errorf("series = %d, %v", n, err)
	}
}
