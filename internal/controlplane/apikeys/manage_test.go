package apikeys

import (
	"errors"
	"slices"
	"testing"
)

func TestNormalizeScopes(t *testing.T) {
	for _, tc := range []struct {
		in   []string
		want []string
		err  bool
	}{
		{in: []string{"ingest"}, want: []string{"ingest"}},
		{in: []string{"read", "ingest", "read"}, want: []string{"ingest", "read"}},
		{in: nil, err: true},
		{in: []string{}, err: true},
		{in: []string{"ingest", "admin"}, err: true},
		{in: []string{"INGEST"}, err: true},
	} {
		got, err := NormalizeScopes(tc.in)
		if tc.err {
			if !errors.Is(err, ErrInvalid) {
				t.Errorf("NormalizeScopes(%q) err = %v, want ErrInvalid", tc.in, err)
			}
			continue
		}
		if err != nil || !slices.Equal(got, tc.want) {
			t.Errorf("NormalizeScopes(%q) = %q, %v; want %q", tc.in, got, err, tc.want)
		}
	}
}
