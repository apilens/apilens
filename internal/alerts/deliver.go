package alerts

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Generic webhook deliveries carry these headers. The signature is
// "v1=" + hex(HMAC-SHA256(secret, timestamp + "." + body)) where timestamp
// is the X-APILens-Timestamp value (Unix seconds); receivers recompute it
// over the raw body and reject stale timestamps (see VerifyWebhookSignature).
const (
	HeaderWebhookEvent     = "X-APILens-Event"
	HeaderWebhookDelivery  = "X-APILens-Delivery"
	HeaderWebhookTimestamp = "X-APILens-Timestamp"
	HeaderWebhookSignature = "X-APILens-Signature"
)

// deliverTimeout bounds one HTTP delivery.
const deliverTimeout = 10 * time.Second

// userAgent identifies notification requests.
const userAgent = "APILens-Alerts/1"

// SignWebhook returns the X-APILens-Signature value for body sent at ts.
func SignWebhook(secret string, ts time.Time, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(strconv.FormatInt(ts.Unix(), 10)))
	mac.Write([]byte("."))
	mac.Write(body)
	return "v1=" + hex.EncodeToString(mac.Sum(nil))
}

// ErrBadSignature is returned by VerifyWebhookSignature.
var ErrBadSignature = errors.New("alerts: webhook signature does not match")

// VerifyWebhookSignature checks a delivery's timestamp and signature
// headers against body, as a receiver would: the timestamp must be within
// tolerance of now and the signature must match in constant time.
func VerifyWebhookSignature(secret, timestamp, signature string, body []byte, now time.Time, tolerance time.Duration) error {
	sec, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil {
		return ErrBadSignature
	}
	ts := time.Unix(sec, 0)
	if d := now.Sub(ts); d > tolerance || d < -tolerance {
		return ErrBadSignature
	}
	if !hmac.Equal([]byte(SignWebhook(secret, ts, body)), []byte(signature)) {
		return ErrBadSignature
	}
	return nil
}

// DeliveryError is a failed HTTP delivery. Its message never carries the
// channel's URL or secret: only the failure class and the status code.
type DeliveryError struct {
	// Status is the response status, 0 when no response arrived.
	Status int
	// Permanent is true when retrying cannot help (a 4xx other than 408 and
	// 429, or a blocked address).
	Permanent bool
	reason    string
}

func (e *DeliveryError) Error() string {
	if e.Status != 0 {
		return fmt.Sprintf("alerts: delivery failed: HTTP %d", e.Status)
	}
	return "alerts: delivery failed: " + e.reason
}

// errBlockedAddress is returned by the dialer for a non-public address.
var errBlockedAddress = errors.New("address not allowed")

// PosterOptions configures a Poster.
type PosterOptions struct {
	// Client sends the requests. Nil: a client that refuses to connect to
	// loopback, private, link-local and other non-public addresses (unless
	// AllowPrivateNetworks), follows no redirects and uses no proxy.
	Client *http.Client
	// AllowPrivateNetworks lets the default client reach non-public
	// addresses.
	AllowPrivateNetworks bool
	// Now is the clock for webhook timestamps; nil is time.Now.
	Now func() time.Time
}

// Poster posts notifications to Slack, Teams and generic webhooks.
type Poster struct {
	client *http.Client
	now    func() time.Time
}

// NewPoster returns a Poster.
func NewPoster(opts PosterOptions) *Poster {
	p := &Poster{client: opts.Client, now: opts.Now}
	if p.client == nil {
		p.client = newGuardedClient(opts.AllowPrivateNetworks, deliverTimeout)
	}
	if p.now == nil {
		p.now = time.Now
	}
	return p
}

// newGuardedClient returns a client whose requests time out after timeout,
// that follows no redirects, uses no proxy and, unless allowPrivate, refuses
// to connect to a non-public address. The address is checked when the
// connection is dialed, after DNS resolution, so a public name that
// resolves to a private address is refused too.
func newGuardedClient(allowPrivate bool, timeout time.Duration) *http.Client {
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	if !allowPrivate {
		dialer.Control = func(_, address string, _ syscall.RawConn) error {
			ap, err := netip.ParseAddrPort(address)
			if err != nil || !publicAddr(ap.Addr()) {
				return errBlockedAddress
			}
			return nil
		}
	}
	return &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			Proxy:                 nil,
			DialContext:           dialer.DialContext,
			TLSHandshakeTimeout:   5 * time.Second,
			ResponseHeaderTimeout: timeout,
			MaxIdleConnsPerHost:   2,
			IdleConnTimeout:       90 * time.Second,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// publicAddr reports whether a is a globally routable unicast address.
func publicAddr(a netip.Addr) bool {
	a = a.Unmap()
	if !a.IsValid() || a.IsLoopback() || a.IsPrivate() || a.IsLinkLocalUnicast() || a.IsLinkLocalMulticast() ||
		a.IsInterfaceLocalMulticast() || a.IsMulticast() || a.IsUnspecified() {
		return false
	}
	// Carrier-grade NAT (100.64.0.0/10), not covered by IsPrivate.
	if a.Is4() && netip.MustParsePrefix("100.64.0.0/10").Contains(a) {
		return false
	}
	return true
}

// Post sends n to the Slack, Teams or webhook channel configured by cfg.
// delivery identifies the delivery to webhook receivers (stable across
// retries, so receivers can drop duplicates).
func (p *Poster) Post(ctx context.Context, cfg ChannelConfig, n Notification, delivery string) error {
	var (
		target string
		body   []byte
		err    error
		header = http.Header{}
	)
	switch {
	case cfg.Slack != nil:
		target = cfg.Slack.WebhookURL
		body, err = n.SlackPayload()
	case cfg.Teams != nil:
		target = cfg.Teams.WebhookURL
		body, err = n.TeamsPayload()
	case cfg.Webhook != nil:
		target = cfg.Webhook.URL
		body, err = n.WebhookPayload()
		ts := p.now()
		header.Set(HeaderWebhookEvent, n.WebhookEventType())
		header.Set(HeaderWebhookDelivery, delivery)
		header.Set(HeaderWebhookTimestamp, strconv.FormatInt(ts.Unix(), 10))
		header.Set(HeaderWebhookSignature, SignWebhook(cfg.Webhook.Secret, ts, body))
	default:
		return &DeliveryError{Permanent: true, reason: "channel " + string(cfg.Type) + " is not posted over HTTP"}
	}
	if err != nil {
		return fmt.Errorf("alerts: build %s payload: %w", cfg.Type, err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(body))
	if err != nil {
		// The URL was validated when the channel was saved; never quote it.
		return &DeliveryError{Permanent: true, reason: "invalid URL"}
	}
	req.Header = header
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", userAgent)
	resp, err := p.client.Do(req)
	if err != nil {
		return transportError(err)
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	return &DeliveryError{
		Status: resp.StatusCode,
		Permanent: resp.StatusCode >= 400 && resp.StatusCode < 500 &&
			resp.StatusCode != http.StatusRequestTimeout && resp.StatusCode != http.StatusTooManyRequests,
	}
}

// transportError classifies a client error without its *url.Error, whose
// message quotes the request URL (a secret for every channel).
func transportError(err error) *DeliveryError {
	var (
		dns  *net.DNSError
		nerr net.Error
		cert *tls.CertificateVerificationError
	)
	switch {
	case errors.Is(err, errBlockedAddress):
		return &DeliveryError{Permanent: true, reason: "address not allowed (not a public address)"}
	case errors.Is(err, context.Canceled):
		return &DeliveryError{reason: "canceled"}
	case errors.Is(err, context.DeadlineExceeded), errors.As(err, &nerr) && nerr.Timeout():
		return &DeliveryError{reason: "timeout"}
	case errors.As(err, &dns):
		return &DeliveryError{reason: "DNS lookup failed"}
	case errors.As(err, &cert), strings.Contains(err.Error(), "tls:"):
		return &DeliveryError{reason: "TLS handshake failed"}
	case errors.Is(err, syscall.ECONNREFUSED):
		return &DeliveryError{reason: "connection refused"}
	default:
		return &DeliveryError{reason: "connection failed"}
	}
}
