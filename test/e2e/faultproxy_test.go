package e2e

// The fault proxy of the failure drills (drills_e2e_test.go). It has no build
// tag so its own tests (faultproxy_unit_test.go) run with the unit tests.

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// faultMode is what the proxy does with the SDK traffic it receives.
type faultMode string

const (
	// faultNone forwards every request to the ingest edge.
	faultNone faultMode = "none"
	// faultDown closes the listener: connections are refused, as when the
	// edge is stopped. Leaving it opens the listener again on the same port.
	faultDown faultMode = "down"
	// faultServerError answers 503 without forwarding.
	faultServerError faultMode = "5xx"
	// faultRateLimited answers 429 with Retry-After without forwarding.
	faultRateLimited faultMode = "429"
)

// maxProxyBody bounds a request body the proxy reads (ingest takes at most a
// few MiB per batch).
const maxProxyBody = 32 << 20

// dataPaths are the batch endpoints the SDKs retry; heartbeat and metadata
// are recorded but are not batches.
var dataPaths = map[string]bool{"/v1/requests": true, "/v1/traces": true, "/v1/logs": true}

// proxyAttempt is one request an SDK sent through the proxy.
type proxyAttempt struct {
	At        time.Time
	Path      string
	App       string    // app_id of the first record; empty for non-batch paths
	Body      string    // sha256 of the decompressed body: equal for retries of one batch
	Records   int       // records in the batch
	Mode      faultMode // the proxy's mode when the request arrived
	Status    int       // status the SDK got (from the edge when forwarded)
	Forwarded bool
}

// isBatch reports whether a is a delivery attempt of a data batch.
func (a proxyAttempt) isBatch() bool { return dataPaths[a.Path] }

// faultProxy is an HTTP reverse proxy between the example apps' SDKs and the
// ingest edge that injects ingest outages, 5xx and 429 with Retry-After, and
// records every attempt so the drills can check retries and duplicates.
type faultProxy struct {
	upstream string // edge base URL, e.g. http://127.0.0.1:8080
	client   *http.Client

	mu         sync.Mutex
	addr       string // resolved listen address, reused after faultDown
	srv        *http.Server
	mode       faultMode
	retryAfter int // seconds, for faultRateLimited
	attempts   []proxyAttempt
}

// newFaultProxy listens on addr (host:port; port 0 picks one) and forwards to
// upstream until set changes the mode.
func newFaultProxy(addr, upstream string) (*faultProxy, error) {
	p := &faultProxy{
		upstream: strings.TrimRight(upstream, "/"),
		client:   &http.Client{Timeout: 30 * time.Second},
		addr:     addr,
		mode:     faultNone,
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if err := p.listenLocked(); err != nil {
		return nil, err
	}
	return p, nil
}

// Addr is the address the proxy listens on.
func (p *faultProxy) Addr() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.addr
}

func (p *faultProxy) listenLocked() error {
	var lc net.ListenConfig
	ln, err := lc.Listen(context.Background(), "tcp", p.addr)
	if err != nil {
		return fmt.Errorf("fault proxy: listen %s: %w", p.addr, err)
	}
	p.addr = ln.Addr().String()
	srv := &http.Server{Handler: p, ReadHeaderTimeout: 10 * time.Second}
	p.srv = srv
	go func() { _ = srv.Serve(ln) }()
	return nil
}

// set switches the mode. Entering faultDown closes the listener and every
// open connection; leaving it listens again on the same address.
func (p *faultProxy) set(mode faultMode, retryAfter int) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	prev := p.mode
	p.mode, p.retryAfter = mode, retryAfter
	switch {
	case mode == faultDown && prev != faultDown:
		srv := p.srv
		p.srv = nil
		return srv.Close()
	case mode != faultDown && prev == faultDown:
		return p.listenLocked()
	}
	return nil
}

// Close stops the proxy.
func (p *faultProxy) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.srv == nil {
		return nil
	}
	err := p.srv.Close()
	p.srv = nil
	return err
}

// attemptsBetween returns the attempts that arrived in [from, to), oldest
// first.
func (p *faultProxy) attemptsBetween(from, to time.Time) []proxyAttempt {
	p.mu.Lock()
	defer p.mu.Unlock()
	var out []proxyAttempt
	for _, a := range p.attempts {
		if !a.At.Before(from) && a.At.Before(to) {
			out = append(out, a)
		}
	}
	// Recorded when answered; ordered by arrival.
	slices.SortStableFunc(out, func(x, y proxyAttempt) int { return x.At.Compare(y.At) })
	return out
}

func (p *faultProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxProxyBody+1))
	if err != nil || len(body) > maxProxyBody {
		http.Error(w, "fault proxy: unreadable body", http.StatusBadRequest)
		return
	}
	a := proxyAttempt{At: time.Now(), Path: r.URL.Path}
	if a.isBatch() {
		a.Body, a.App, a.Records = describeBatch(body, r.Header.Get("Content-Encoding"))
	}
	p.mu.Lock()
	a.Mode = p.mode
	retryAfter := p.retryAfter
	p.mu.Unlock()

	switch a.Mode {
	case faultServerError:
		a.Status = http.StatusServiceUnavailable
		writeProxyError(w, a.Status, nil)
	case faultRateLimited:
		a.Status = http.StatusTooManyRequests
		writeProxyError(w, a.Status, http.Header{"Retry-After": {strconv.Itoa(retryAfter)}})
	default:
		a.Status, a.Forwarded = p.forward(w, r, body), true
	}
	p.record(a)
}

func (p *faultProxy) record(a proxyAttempt) {
	p.mu.Lock()
	p.attempts = append(p.attempts, a)
	p.mu.Unlock()
}

// forward sends the request to the edge and copies the answer back; it
// returns the status the SDK got (502 when the edge was unreachable).
func (p *faultProxy) forward(w http.ResponseWriter, r *http.Request, body []byte) int {
	req, err := http.NewRequestWithContext(r.Context(), r.Method, p.upstream+r.URL.RequestURI(), bytes.NewReader(body))
	if err != nil {
		writeProxyError(w, http.StatusBadGateway, nil)
		return http.StatusBadGateway
	}
	req.Header = r.Header.Clone()
	req.Header.Del("Connection")
	resp, err := p.client.Do(req)
	if err != nil {
		writeProxyError(w, http.StatusBadGateway, nil)
		return http.StatusBadGateway
	}
	defer func() { _ = resp.Body.Close() }()
	for k, vs := range resp.Header {
		if k == "Connection" || k == "Content-Length" {
			continue
		}
		w.Header()[k] = vs
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
	return resp.StatusCode
}

func writeProxyError(w http.ResponseWriter, status int, h http.Header) {
	for k, vs := range h {
		w.Header()[k] = vs
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = fmt.Fprintf(w, `{"error":"failure drill: %s"}`, strings.ToLower(http.StatusText(status)))
}

// describeBatch hashes a batch body (decompressed, so a retry re-gzipped
// with another timestamp hashes the same) and reads the app_id of its first
// record and its record count. A body it cannot decode hashes as sent.
func describeBatch(body []byte, encoding string) (hash, app string, records int) {
	raw := body
	if strings.EqualFold(strings.TrimSpace(encoding), "gzip") {
		if zr, err := gzip.NewReader(bytes.NewReader(body)); err == nil {
			if b, err := io.ReadAll(io.LimitReader(zr, maxProxyBody)); err == nil || errors.Is(err, io.ErrUnexpectedEOF) {
				raw = b
			}
		}
	}
	sum := sha256.Sum256(raw)
	hash = hex.EncodeToString(sum[:])
	var env map[string][]struct {
		AppID string `json:"app_id"`
	}
	if json.Unmarshal(raw, &env) != nil {
		return hash, "", 0
	}
	for _, key := range []string{"requests", "spans", "logs"} {
		recs := env[key]
		records += len(recs)
		if app == "" && len(recs) > 0 {
			app = recs[0].AppID
		}
	}
	return hash, app, records
}

// duplicateDeliveries returns the batches (by body hash) the edge accepted
// more than once, with how often.
func duplicateDeliveries(attempts []proxyAttempt) map[string]int {
	delivered := map[string]int{}
	for _, a := range attempts {
		if a.isBatch() && a.Forwarded && a.Status >= 200 && a.Status < 300 {
			delivered[a.Body]++
		}
	}
	for h, n := range delivered {
		if n < 2 {
			delete(delivered, h)
		}
	}
	return delivered
}

// retryGapsAfter429 returns, for app, the time between a batch attempt the
// proxy answered 429 and the next attempt of the same batch.
func retryGapsAfter429(attempts []proxyAttempt, app string) []time.Duration {
	last := map[string]proxyAttempt{}
	var gaps []time.Duration
	for _, a := range attempts {
		if !a.isBatch() || a.App != app {
			continue
		}
		if prev, ok := last[a.Body]; ok && prev.Status == http.StatusTooManyRequests {
			gaps = append(gaps, a.At.Sub(prev.At))
		}
		last[a.Body] = a
	}
	return gaps
}
