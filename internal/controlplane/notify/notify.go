// Package notify tells project admins about sensitive changes to a project
// by email (D13 in #753): API keys created, rotated or revoked, the default
// access changed, the project paused, resumed, scheduled for deletion or
// restored.
//
// ProjectAdmins enqueues one `email.send` job per effective project admin
// (org owners and admins, and direct admin grants) in the caller's
// transaction, so the emails go out only if the change commits. The user
// who made the change is never emailed about it. Admins who turned off the
// security_emails preference get no project_change email; the deletion
// email ignores the preference, because a scheduled deletion destroys data.
package notify

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"

	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/email"
)

// Changes an Event reports: the project_change values of internal/email,
// and DeletionScheduled.
const (
	KeyCreated           = email.ProjectChangeKeyCreated
	KeyRotated           = email.ProjectChangeKeyRotated
	KeyRevoked           = email.ProjectChangeKeyRevoked
	DefaultAccessChanged = email.ProjectChangeDefaultAccessChanged
	Restored             = email.ProjectChangeRestored
	Paused               = email.ProjectChangePaused
	Resumed              = email.ProjectChangeResumed
	// DeletionScheduled is sent with the project_deletion_scheduled
	// template, whatever the recipient's security_emails preference.
	DeletionScheduled = "deletion_scheduled"
)

// SystemActor is the name shown when a change has no user behind it.
const SystemActor = "APILens"

// ErrInvalidEvent is returned for an unknown change, a key change without
// the key name, a default access change without the new access, or a
// deletion without its purge time.
var ErrInvalidEvent = errors.New("notify: invalid event")

// Event is one sensitive change to a project.
type Event struct {
	Change string    // one of the changes above
	Actor  uuid.UUID // who made it; never emailed. uuid.Nil: no user (SystemActor)
	// Detail is the key name for key changes and the new default access
	// (org_role, viewer or none) for DefaultAccessChanged.
	Detail string
	// PurgeAt is when a deleted project is removed for good
	// (DeletionScheduled only).
	PurgeAt time.Time
	// At is when the change happened; zero means now.
	At time.Time
}

// Enqueuer inserts jobs inside a transaction; *jobs.Client satisfies it.
type Enqueuer interface {
	InsertTx(ctx context.Context, tx pgx.Tx, args river.JobArgs, opts *river.InsertOpts) (*rivertype.JobInsertResult, error)
}

// Notifier sends the project change emails.
type Notifier struct {
	jobs Enqueuer
	now  func() time.Time
}

// New returns a Notifier that enqueues on jobs.
func New(jobs Enqueuer) *Notifier { return &Notifier{jobs: jobs, now: time.Now} }

// defaultAccess is the email wording of each default access.
var defaultAccess = map[string]string{
	"org_role": "their organization role (members edit, viewers view)",
	"viewer":   "view only, for everyone in the organization",
	"none":     "no access (only organization owners and admins and people added directly)",
}

// ProjectAdmins enqueues the email for ev, in tx, to every admin of project
// except the actor, and returns how many it enqueued. Call it in the
// transaction that makes the change; for DeletionScheduled, after the
// project is marked deleted is fine (deleted projects keep their admins
// until the purge).
func (n *Notifier) ProjectAdmins(ctx context.Context, tx pgx.Tx, project uuid.UUID, ev Event) (int, error) {
	if err := ev.validate(); err != nil {
		return 0, err
	}
	q := db.New(tx)
	admins, err := q.ListProjectAdminRecipients(ctx, project)
	if err != nil {
		return 0, fmt.Errorf("notify: list admins: %w", err)
	}
	actor := SystemActor
	if ev.Actor != uuid.Nil {
		name, err := q.GetNotifyActor(ctx, ev.Actor)
		switch {
		case err == nil:
			actor = name
		case !errors.Is(err, pgx.ErrNoRows):
			return 0, fmt.Errorf("notify: actor: %w", err)
		}
	}
	at := ev.At
	if at.IsZero() {
		at = n.now()
	}
	sent := 0
	for _, a := range admins {
		if a.UserID == ev.Actor {
			continue
		}
		args := email.SendArgs{To: a.Email}
		data := map[string]any{
			"project": a.ProjectName,
			"slug":    a.ProjectSlug,
			"actor":   actor,
			"time":    at.UTC().Format(time.RFC3339),
		}
		if ev.Change == DeletionScheduled {
			args.Template = email.TemplateProjectDeletionScheduled
			data["purge_at"] = ev.PurgeAt.UTC().Format(time.RFC3339)
		} else {
			if !a.SecurityEmails {
				continue
			}
			args.Template = email.TemplateProjectChange
			data["change"] = ev.Change
			data["detail"] = ev.detail()
		}
		args.Data = data
		if _, err := n.jobs.InsertTx(ctx, tx, args, nil); err != nil {
			return sent, fmt.Errorf("notify: enqueue %s email: %w", ev.Change, err)
		}
		sent++
	}
	return sent, nil
}

func (ev Event) validate() error {
	switch ev.Change {
	case KeyCreated, KeyRotated, KeyRevoked:
		if strings.TrimSpace(ev.Detail) == "" {
			return fmt.Errorf("%w: %s needs the key name", ErrInvalidEvent, ev.Change)
		}
	case DefaultAccessChanged:
		if _, ok := defaultAccess[ev.Detail]; !ok {
			return fmt.Errorf("%w: unknown default access %q", ErrInvalidEvent, ev.Detail)
		}
	case Restored, Paused, Resumed:
	case DeletionScheduled:
		if ev.PurgeAt.IsZero() {
			return fmt.Errorf("%w: deletion needs the purge time", ErrInvalidEvent)
		}
	default:
		return fmt.Errorf("%w: unknown change %q", ErrInvalidEvent, ev.Change)
	}
	return nil
}

// detail is the project_change detail of ev: the key name, the wording of
// the new default access, or empty.
func (ev Event) detail() string {
	switch ev.Change {
	case DefaultAccessChanged:
		return defaultAccess[ev.Detail]
	case KeyCreated, KeyRotated, KeyRevoked:
		return ev.Detail
	default:
		return ""
	}
}
