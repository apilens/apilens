package jobs

import (
	"context"
	"slices"
	"testing"

	"github.com/riverqueue/river"
)

type alphaArgs struct{}

func (alphaArgs) Kind() string { return "test.alpha" }

type betaArgs struct{}

func (betaArgs) Kind() string { return "test.beta" }

func TestRegistryKinds(t *testing.T) {
	r := NewRegistry()
	if len(r.Kinds()) != 0 {
		t.Fatalf("new registry kinds = %v", r.Kinds())
	}
	Register(r, river.WorkFunc(func(context.Context, *river.Job[betaArgs]) error { return nil }))
	Register(r, river.WorkFunc(func(context.Context, *river.Job[alphaArgs]) error { return nil }))
	if got, want := r.Kinds(), []string{"test.alpha", "test.beta"}; !slices.Equal(got, want) {
		t.Fatalf("Kinds() = %v, want %v", got, want)
	}
}

func TestRegisterDuplicatePanics(t *testing.T) {
	r := NewRegistry()
	Register(r, river.WorkFunc(func(context.Context, *river.Job[alphaArgs]) error { return nil }))
	defer func() {
		if recover() == nil {
			t.Fatal("registering a kind twice should panic")
		}
	}()
	Register(r, river.WorkFunc(func(context.Context, *river.Job[alphaArgs]) error { return nil }))
}
