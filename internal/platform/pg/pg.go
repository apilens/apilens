// Package pg opens the shared Postgres pool.
package pg

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/apilens/apilens/internal/platform/config"
)

// Connect opens a pgx pool and verifies connectivity.
func Connect(ctx context.Context, cfg config.PostgresConfig, appName string) (*pgxpool.Pool, error) {
	pcfg, err := pgxpool.ParseConfig(cfg.URL)
	if err != nil {
		return nil, fmt.Errorf("pg: parse url: %w", err)
	}
	pcfg.MaxConns = cfg.MaxConns
	if pcfg.ConnConfig.RuntimeParams == nil {
		pcfg.ConnConfig.RuntimeParams = map[string]string{}
	}
	if _, ok := pcfg.ConnConfig.RuntimeParams["application_name"]; !ok {
		pcfg.ConnConfig.RuntimeParams["application_name"] = appName
	}
	pool, err := pgxpool.NewWithConfig(ctx, pcfg)
	if err != nil {
		return nil, fmt.Errorf("pg: connect: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("pg: ping: %w", err)
	}
	return pool, nil
}
