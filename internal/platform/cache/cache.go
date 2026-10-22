// Package cache wraps the Valkey client used for cross-process cache
// invalidation, shared rate limits and (later) resumable streams.
package cache

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/valkey-io/valkey-go"

	"github.com/apilens/apilens/internal/platform/config"
)

// Connect opens a Valkey client and verifies connectivity.
func Connect(ctx context.Context, cfg config.ValkeyConfig) (valkey.Client, error) {
	client, err := valkey.NewClient(valkey.ClientOption{
		InitAddress: cfg.Addr,
		Username:    cfg.Username,
		Password:    cfg.Password,
		// We use Valkey for pub/sub and counters, not as a read-through
		// cache, so server-assisted client-side caching stays off.
		DisableCache: true,
	})
	if err != nil {
		return nil, fmt.Errorf("valkey: connect: %w", err)
	}
	if err := Ping(ctx, client); err != nil {
		client.Close()
		return nil, err
	}
	return client, nil
}

// Ping checks connectivity.
func Ping(ctx context.Context, client valkey.Client) error {
	if err := client.Do(ctx, client.B().Ping().Build()).Error(); err != nil {
		return fmt.Errorf("valkey: ping: %w", err)
	}
	return nil
}

// Publish sends message on channel.
func Publish(ctx context.Context, client valkey.Client, channel, message string) error {
	return client.Do(ctx, client.B().Publish().Channel(channel).Message(message).Build()).Error()
}

// Subscribe calls fn for every message on channel until ctx is cancelled,
// reconnecting with backoff when the connection drops.
func Subscribe(ctx context.Context, client valkey.Client, logger *slog.Logger, channel string, fn func(string)) {
	backoff := 250 * time.Millisecond
	for ctx.Err() == nil {
		err := client.Receive(ctx, client.B().Subscribe().Channel(channel).Build(), func(msg valkey.PubSubMessage) {
			fn(msg.Message)
		})
		if ctx.Err() != nil {
			return
		}
		logger.Warn("valkey subscription dropped; retrying", "channel", channel, "error", err, "backoff", backoff)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 10*time.Second)
	}
}
