// Package email sends transactional email (sign-in codes, invitations,
// security alerts).
//
// Request handlers never send mail inline: they enqueue an `email.send` River
// job (SendArgs) and the Worker renders the named template and hands the
// message to a Sender. Retries and backoff belong to the queue. Two senders
// exist, picked by email.provider: smtp (go-mail) and log (writes the rendered
// message to the logger, for development).
package email

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net/mail"
	"strings"
	"time"

	gomail "github.com/wneessen/go-mail"

	"github.com/apilens/apilens/internal/platform/config"
)

// Message is a rendered email ready to send.
type Message struct {
	// ID is the Message-ID without angle brackets. Senders fill it when
	// empty, before any network I/O, so failures can be logged with it.
	ID       string
	To       string
	Subject  string
	Text     string
	HTML     string // optional; when set the message is multipart/alternative
	Template string // template name, for logs only
}

// Sender delivers a rendered message.
type Sender interface {
	// Send delivers msg. It sets msg.ID if empty, also when it fails.
	Send(ctx context.Context, msg *Message) error
}

// NewSender returns the Sender for cfg.Provider.
func NewSender(cfg config.EmailConfig, logger *slog.Logger) (Sender, error) {
	switch cfg.Provider {
	case config.EmailProviderLog:
		return NewLogSender(logger), nil
	case config.EmailProviderSMTP:
		return NewSMTPSender(cfg)
	default:
		return nil, fmt.Errorf("email: unknown provider %q", cfg.Provider)
	}
}

// LogSender writes each rendered message to the logger and delivers nothing.
type LogSender struct{ logger *slog.Logger }

// NewLogSender returns a LogSender.
func NewLogSender(logger *slog.Logger) *LogSender { return &LogSender{logger: logger} }

// Send logs msg, including its body: the log provider exists so developers
// can read sign-in codes without a mail server.
func (s *LogSender) Send(ctx context.Context, msg *Message) error {
	if msg.ID == "" {
		msg.ID = newMessageID("localhost")
	}
	s.logger.InfoContext(ctx, "email (log provider, not delivered)",
		"message_id", msg.ID, "template", msg.Template, "to", msg.To, "subject", msg.Subject,
		"text", msg.Text, "html", msg.HTML)
	return nil
}

// SMTPSender delivers mail through an SMTP relay with go-mail.
type SMTPSender struct {
	cfg    config.EmailConfig
	domain string // Message-ID right-hand side, from cfg.From
}

// NewSMTPSender returns an SMTPSender. It does not dial.
func NewSMTPSender(cfg config.EmailConfig) (*SMTPSender, error) {
	from, err := mail.ParseAddress(cfg.From)
	if err != nil {
		return nil, fmt.Errorf("email: from %q: %w", cfg.From, err)
	}
	domain := "localhost"
	if _, d, ok := strings.Cut(from.Address, "@"); ok && d != "" {
		domain = d
	}
	s := &SMTPSender{cfg: cfg, domain: domain}
	if _, err := s.client(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *SMTPSender) client() (*gomail.Client, error) {
	opts := []gomail.Option{gomail.WithPort(s.cfg.Port), gomail.WithTimeout(s.cfg.Timeout)}
	switch s.cfg.TLS {
	case config.EmailTLSImplicit:
		opts = append(opts, gomail.WithSSL(), gomail.WithTLSPolicy(gomail.NoTLS))
	case config.EmailTLSNone:
		opts = append(opts, gomail.WithTLSPolicy(gomail.NoTLS))
	default: // starttls
		opts = append(opts, gomail.WithTLSPolicy(gomail.TLSMandatory))
	}
	if s.cfg.Username != "" {
		opts = append(opts, gomail.WithSMTPAuth(gomail.SMTPAuthAutoDiscover),
			gomail.WithUsername(s.cfg.Username), gomail.WithPassword(s.cfg.Password))
	}
	c, err := gomail.NewClient(s.cfg.Host, opts...)
	if err != nil {
		return nil, fmt.Errorf("email: smtp client: %w", err)
	}
	return c, nil
}

// Send dials the relay and delivers msg. A fresh connection per message keeps
// the sender safe for concurrent workers.
func (s *SMTPSender) Send(ctx context.Context, msg *Message) error {
	if msg.ID == "" {
		msg.ID = newMessageID(s.domain)
	}
	m, err := s.build(msg)
	if err != nil {
		return err
	}
	c, err := s.client()
	if err != nil {
		return err
	}
	if err := c.DialAndSendWithContext(ctx, m); err != nil {
		return fmt.Errorf("email: smtp send: %w", err)
	}
	return nil
}

func (s *SMTPSender) build(msg *Message) (*gomail.Msg, error) {
	m := gomail.NewMsg(gomail.WithNoDefaultUserAgent())
	if err := m.From(s.cfg.From); err != nil {
		return nil, fmt.Errorf("email: from: %w", err)
	}
	if err := m.To(msg.To); err != nil {
		return nil, fmt.Errorf("email: to: %w", err)
	}
	if s.cfg.ReplyTo != "" {
		if err := m.ReplyTo(s.cfg.ReplyTo); err != nil {
			return nil, fmt.Errorf("email: reply-to: %w", err)
		}
	}
	m.Subject(msg.Subject)
	m.SetMessageIDWithValue(msg.ID)
	m.SetDateWithValue(time.Now())
	m.SetUserAgent("APILens")
	// RFC 3834: tell auto-responders (out-of-office) not to reply.
	m.SetGenHeader(gomail.Header("Auto-Submitted"), "auto-generated")
	m.SetBodyString(gomail.TypeTextPlain, msg.Text)
	if msg.HTML != "" {
		m.AddAlternativeString(gomail.TypeTextHTML, msg.HTML)
	}
	return m, nil
}

// newMessageID returns a random Message-ID (without angle brackets).
func newMessageID(domain string) string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b) + "@" + domain
}
