package notify

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestInvalidEvents(t *testing.T) {
	n := New(nil)
	for _, ev := range []Event{
		{Change: "project_exploded"},
		{Change: KeyCreated},
		{Change: KeyRevoked, Detail: "  "},
		{Change: DefaultAccessChanged, Detail: "everyone"},
		{Change: DeletionScheduled},
	} {
		// validate runs before the transaction is touched, so a nil tx is
		// never used.
		if _, err := n.ProjectAdmins(context.Background(), nil, uuid.New(), ev); !errors.Is(err, ErrInvalidEvent) {
			t.Errorf("%+v: err = %v; want ErrInvalidEvent", ev, err)
		}
	}
}

func TestValidEvents(t *testing.T) {
	for _, ev := range []Event{
		{Change: KeyCreated, Detail: "checkout"},
		{Change: KeyRotated, Detail: "checkout"},
		{Change: KeyRevoked, Detail: "checkout"},
		{Change: DefaultAccessChanged, Detail: "org_role"},
		{Change: DefaultAccessChanged, Detail: "viewer"},
		{Change: DefaultAccessChanged, Detail: "none"},
		{Change: Restored}, {Change: Paused}, {Change: Resumed},
		{Change: DeletionScheduled, PurgeAt: time.Now()},
	} {
		if err := ev.validate(); err != nil {
			t.Errorf("%+v: %v", ev, err)
		}
	}
}

func TestDetail(t *testing.T) {
	if got := (Event{Change: DefaultAccessChanged, Detail: "viewer"}).detail(); got != defaultAccess["viewer"] {
		t.Errorf("default access detail = %q", got)
	}
	if got := (Event{Change: Paused, Detail: "ignored"}).detail(); got != "" {
		t.Errorf("paused detail = %q", got)
	}
}
