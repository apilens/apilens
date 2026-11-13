package migrations

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/apilens/apilens/internal/platform/ch"
	"github.com/apilens/apilens/internal/platform/config"
	"github.com/apilens/apilens/internal/retention"
)

// ErrRetentionShortened is returned by ApplyRetention when the config
// shortens a retention period and the change was not confirmed.
var ErrRetentionShortened = errors.New("retention: shortening a retention period deletes data")

// ApplyRetention sets the ClickHouse table TTLs to the retention.* config
// (run it after UpClickHouse). Tables whose TTL already matches are left
// alone. Shortening a period deletes the rows past the new period, so it is
// refused unless confirm is set; nothing is changed when any shortening is
// refused.
func ApplyRetention(ctx context.Context, cfg config.ClickHouseConfig, r config.RetentionConfig, confirm bool, logger *slog.Logger) error {
	db := ch.OpenDB(cfg, "")
	defer func() { _ = db.Close() }()
	current, err := currentRetention(ctx, db)
	if err != nil {
		return err
	}
	type change struct {
		sig      retention.Signal
		from, to int
	}
	var changes []change
	var shortened []string
	for _, s := range retention.Signals {
		if !s.Configurable {
			continue
		}
		from, ok := current[s.Table]
		if !ok {
			return fmt.Errorf("retention: table %s has no TTL to change", s.Table)
		}
		to := s.Days(r)
		if to == from {
			continue
		}
		changes = append(changes, change{s, from, to})
		if to < from {
			shortened = append(shortened, fmt.Sprintf("retention.%s %d -> %d days (table %s)", s.Key, from, to, s.Table))
		}
	}
	if len(shortened) > 0 && !confirm {
		return fmt.Errorf("%w older than the new period: %s; re-run `apilens migrate` with -confirm-retention-change to apply it",
			ErrRetentionShortened, strings.Join(shortened, ", "))
	}
	for _, c := range changes {
		if c.to < c.from {
			logger.Warn("shortening retention deletes data older than the new period",
				"table", c.sig.Table, "key", "retention."+c.sig.Key, "from_days", c.from, "to_days", c.to)
		}
		if _, err := db.ExecContext(ctx, c.sig.ModifyTTL(c.to)); err != nil {
			return fmt.Errorf("retention: modify TTL of %s: %w", c.sig.Table, err)
		}
		logger.Info("retention changed", "table", c.sig.Table, "key", "retention."+c.sig.Key, "from_days", c.from, "to_days", c.to)
	}
	logger.Info("retention up to date", "changed", len(changes))
	return nil
}

// currentRetention reads each signal table's TTL in days from ClickHouse.
func currentRetention(ctx context.Context, db *sql.DB) (map[string]int, error) {
	rows, err := db.QueryContext(ctx, retention.TablesQuery)
	if err != nil {
		return nil, fmt.Errorf("retention: read table TTLs: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := map[string]int{}
	for rows.Next() {
		var name, stmt string
		if err := rows.Scan(&name, &stmt); err != nil {
			return nil, fmt.Errorf("retention: read table TTLs: %w", err)
		}
		if days, ok := retention.ParseDays(stmt); ok {
			out[name] = days
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("retention: read table TTLs: %w", err)
	}
	return out, nil
}
