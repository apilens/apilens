package projects

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/controlplane/store/db"
)

type fakeEnvCounter struct {
	total, recent int64
	since         time.Time
}

func (f *fakeEnvCounter) CountProjectEnvironments(context.Context, uuid.UUID) (int64, error) {
	return f.total, nil
}

func (f *fakeEnvCounter) CountSDKEnvironmentsSince(_ context.Context, arg db.CountSDKEnvironmentsSinceParams) (int64, error) {
	f.since = arg.Since
	return f.recent, nil
}

func TestEnvironmentLimits(t *testing.T) {
	now := time.Date(2026, 11, 13, 12, 0, 0, 0, time.UTC)
	cases := []struct {
		name          string
		total, recent int64
		want          string // "" for no limit
	}{
		{"room", MaxEnvironments - 1, MaxNewSDKEnvironmentsPerHour - 1, ""},
		{"cap", MaxEnvironments, 0, EnvLimitMax},
		{"cap before rate", MaxEnvironments + 3, MaxNewSDKEnvironmentsPerHour, EnvLimitMax},
		{"rate", 2, MaxNewSDKEnvironmentsPerHour, EnvLimitNewPerHour},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := &fakeEnvCounter{total: c.total, recent: c.recent}
			err := checkEnvironmentLimits(t.Context(), f, uuid.New(), now)
			var limit *EnvironmentLimitError
			switch {
			case c.want == "" && err != nil:
				t.Fatalf("err = %v", err)
			case c.want != "" && (!errors.As(err, &limit) || limit.Limit != c.want):
				t.Fatalf("err = %v, want %s", err, c.want)
			}
			if c.want == EnvLimitNewPerHour && limit.Max != MaxNewSDKEnvironmentsPerHour {
				t.Fatalf("max = %d", limit.Max)
			}
			if c.want != EnvLimitMax && !f.since.Equal(now.Add(-time.Hour)) {
				t.Fatalf("rate window starts %v", f.since)
			}
		})
	}
}

func TestRegisterRefusesInvalidNameWithoutDatabase(t *testing.T) {
	p := NewEnvironmentProvisioner(nil, nil) // no pool: must not be touched
	for _, n := range []string{"", "my env", "-x", string(make([]byte, 65))} {
		if _, err := p.Register(t.Context(), uuid.New(), uuid.New(), n, time.Now()); !errors.Is(err, ErrInvalid) {
			t.Fatalf("%q: %v", n, err)
		}
	}
}
