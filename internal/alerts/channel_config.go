package alerts

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/mail"
	"net/url"
	"strings"
)

// Channel configs: the JSON object sealed in notification_channels.config_enc
// for each channel type. Every value in them is treated as a secret (a Slack,
// Teams or webhook URL is a bearer credential) and is never logged.
//
//	email:   {"addresses": ["oncall@example.com", ...]}       1 to MaxEmailAddresses
//	slack:   {"webhook_url": "https://hooks.slack.com/services/..."}
//	teams:   {"webhook_url": "https://....webhook.office.com/..."}
//	webhook: {"url": "https://example.com/hooks/apilens", "secret": "..."}
//
// The generic webhook signs every request with secret (see SignWebhook).

// MaxEmailAddresses bounds the recipients of one email channel.
const MaxEmailAddresses = 20

// MinWebhookSecretLen is the shortest signing secret a webhook channel takes.
const MinWebhookSecretLen = 16

// maxChannelURLLen bounds a webhook URL.
const maxChannelURLLen = 2048

// ErrInvalidChannelConfig is returned by ParseChannelConfig for a config that
// does not match its channel type. Its messages never include the config's
// values.
var ErrInvalidChannelConfig = errors.New("alerts: invalid channel config")

// EmailConfig is an email channel's config.
type EmailConfig struct {
	Addresses []string `json:"addresses"`
}

// WebhookURLConfig is a Slack or Teams channel's config: the incoming
// webhook URL.
type WebhookURLConfig struct {
	WebhookURL string `json:"webhook_url"`
}

// WebhookConfig is a generic webhook channel's config.
type WebhookConfig struct {
	URL    string `json:"url"`
	Secret string `json:"secret"`
}

// ChannelConfig is a parsed channel config; exactly the field of its Type is
// set.
type ChannelConfig struct {
	Type    ChannelType
	Email   *EmailConfig
	Slack   *WebhookURLConfig
	Teams   *WebhookURLConfig
	Webhook *WebhookConfig
}

// ParseChannelConfig decodes and validates the config of a channel of type
// t. Unknown keys are rejected so a typo cannot silently drop a setting.
func ParseChannelConfig(t ChannelType, raw json.RawMessage) (ChannelConfig, error) {
	c := ChannelConfig{Type: t}
	switch t {
	case ChannelEmail:
		c.Email = &EmailConfig{}
		if err := decodeStrict(t, raw, c.Email); err != nil {
			return ChannelConfig{}, err
		}
		if len(c.Email.Addresses) == 0 || len(c.Email.Addresses) > MaxEmailAddresses {
			return ChannelConfig{}, fmt.Errorf("%w: email needs 1 to %d addresses", ErrInvalidChannelConfig, MaxEmailAddresses)
		}
		for i, a := range c.Email.Addresses {
			if p, err := mail.ParseAddress(a); err != nil || p.Address != a {
				return ChannelConfig{}, fmt.Errorf("%w: email address %d is not a plain address", ErrInvalidChannelConfig, i+1)
			}
		}
	case ChannelSlack, ChannelTeams:
		w := &WebhookURLConfig{}
		if err := decodeStrict(t, raw, w); err != nil {
			return ChannelConfig{}, err
		}
		if err := validateChannelURL(w.WebhookURL); err != nil {
			return ChannelConfig{}, fmt.Errorf("%w: webhook_url %w", ErrInvalidChannelConfig, err)
		}
		if t == ChannelSlack {
			c.Slack = w
		} else {
			c.Teams = w
		}
	case ChannelWebhook:
		c.Webhook = &WebhookConfig{}
		if err := decodeStrict(t, raw, c.Webhook); err != nil {
			return ChannelConfig{}, err
		}
		if err := validateChannelURL(c.Webhook.URL); err != nil {
			return ChannelConfig{}, fmt.Errorf("%w: url %w", ErrInvalidChannelConfig, err)
		}
		if len(c.Webhook.Secret) < MinWebhookSecretLen {
			return ChannelConfig{}, fmt.Errorf("%w: secret must be at least %d characters", ErrInvalidChannelConfig, MinWebhookSecretLen)
		}
	default:
		return ChannelConfig{}, fmt.Errorf("%w: unknown channel type %q", ErrInvalidChannelConfig, t)
	}
	return c, nil
}

func decodeStrict(t ChannelType, raw json.RawMessage, v any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		// The decoder's message can quote the input; keep only the shape.
		var unknown string
		if msg := err.Error(); strings.HasPrefix(msg, "json: unknown field ") {
			unknown = ": " + strings.TrimPrefix(msg, "json: ")
		}
		return fmt.Errorf("%w: not a valid %s config%s", ErrInvalidChannelConfig, t, unknown)
	}
	return nil
}

// validateChannelURL accepts an absolute https URL without credentials or a
// fragment. The error never quotes the URL.
func validateChannelURL(raw string) error {
	if raw == "" || len(raw) > maxChannelURLLen || strings.TrimSpace(raw) != raw {
		return errors.New("must be an https URL")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.Opaque != "" {
		return errors.New("must be an https URL")
	}
	if u.User != nil || u.Fragment != "" {
		return errors.New("must not carry credentials or a fragment")
	}
	return nil
}
