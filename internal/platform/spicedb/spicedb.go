// Package spicedb opens the SpiceDB client and applies the authorization
// schema (ADR 0006).
package spicedb

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"time"

	v1 "github.com/authzed/authzed-go/proto/authzed/api/v1"
	authzed "github.com/authzed/authzed-go/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"github.com/apilens/apilens/internal/platform/config"
)

// Connect returns a SpiceDB client for cfg. The connection is established
// lazily, on the first call.
func Connect(cfg config.AuthzConfig) (*authzed.Client, error) {
	if !cfg.Enabled() {
		return nil, errors.New("spicedb: authz.endpoint is not set")
	}
	transport := credentials.NewTLS(&tls.Config{MinVersion: tls.VersionTLS12})
	if cfg.Insecure {
		transport = insecure.NewCredentials()
	}
	c, err := authzed.NewClient(cfg.Endpoint,
		grpc.WithTransportCredentials(transport),
		grpc.WithPerRPCCredentials(bearerToken{token: cfg.PresharedKey, secure: !cfg.Insecure}),
	)
	if err != nil {
		return nil, fmt.Errorf("spicedb: dial %s: %w", cfg.Endpoint, err)
	}
	return c, nil
}

// bearerToken sends the preshared key on every RPC.
type bearerToken struct {
	token  string
	secure bool
}

func (b bearerToken) GetRequestMetadata(context.Context, ...string) (map[string]string, error) {
	return map[string]string{"authorization": "Bearer " + b.token}, nil
}

func (b bearerToken) RequireTransportSecurity() bool { return b.secure }

// retryWindow bounds how long ApplySchema waits for SpiceDB to come up (it
// may start alongside the migrate job).
const retryWindow = 2 * time.Minute

// ApplySchema writes schema to SpiceDB. WriteSchema is idempotent: writing
// the stored schema again is a no-op. Unavailable errors are retried until
// SpiceDB answers or retryWindow elapses.
func ApplySchema(ctx context.Context, client *authzed.Client, schema string, logger *slog.Logger) error {
	ctx, cancel := context.WithTimeout(ctx, retryWindow)
	defer cancel()
	backoff := 500 * time.Millisecond
	for {
		_, err := client.WriteSchema(ctx, &v1.WriteSchemaRequest{Schema: schema})
		if err == nil {
			logger.Info("authz schema applied")
			return nil
		}
		if status.Code(err) != codes.Unavailable {
			return fmt.Errorf("spicedb: write schema: %w", err)
		}
		logger.Warn("spicedb unavailable, retrying", "err", err, "in", backoff)
		select {
		case <-ctx.Done():
			return fmt.Errorf("spicedb: write schema: %w", err)
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 5*time.Second)
	}
}
