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

func TestRegistryQueues(t *testing.T) {
	r := NewRegistry()
	if len(r.Queues()) != 0 {
		t.Fatalf("new registry queues = %v", r.Queues())
	}
	r.Queue("zeta", 1)
	r.Queue("exports", 2)
	r.Queue("exports", 3)
	if got, want := r.Queues(), []string{"exports", "zeta"}; !slices.Equal(got, want) {
		t.Fatalf("Queues() = %v, want %v", got, want)
	}
	if got := r.queueConfigs()["exports"]; got != 3 {
		t.Fatalf("exports max workers = %d, want 3", got)
	}
}
