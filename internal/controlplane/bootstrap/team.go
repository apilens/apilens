package bootstrap

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/apilens/apilens/internal/controlplane/access"
	"github.com/apilens/apilens/internal/controlplane/apikeys"
	"github.com/apilens/apilens/internal/controlplane/orgs"
	"github.com/apilens/apilens/internal/controlplane/projects"
	"github.com/apilens/apilens/internal/identity/audit"
	identitydb "github.com/apilens/apilens/internal/identity/store/db"
)

// Demo data of `apilens seed -with-team` (#829): the people, the restricted
// project, the environments and the API keys that fill the Access and
// Project settings screens. Every step goes through the service the
// dashboard uses, so the outbox rows and audit events are the real ones,
// and every step first checks what is there, so a second run writes
// nothing.

// TeamMember is a demo user and their organization role.
type TeamMember struct {
	Email string `json:"email"`
	Name  string `json:"name"`
	Role  string `json:"role"`
}

// Team are the demo users -with-team adds next to the dev owner, one per
// organization role below owner (two members, so one can be granted a
// restricted project and the other left out).
var Team = []TeamMember{
	{Email: "ada.admin@example.com", Name: "Ada Admin", Role: orgs.RoleAdmin},
	{Email: "eli.editor@example.com", Name: "Eli Editor", Role: orgs.RoleMember},
	{Email: "mia.member@example.com", Name: "Mia Member", Role: orgs.RoleMember},
	{Email: "val.viewer@example.com", Name: "Val Viewer", Role: orgs.RoleViewer},
}

// RestrictedProjectSlug is the demo project with default access none: only
// org owners and admins and the people granted it directly see it.
const RestrictedProjectSlug = "payments"

// demoEnvironment is an environment of the seeded project with its settings.
type demoEnvironment struct {
	name       string
	production bool
	color      string
	hidden     bool
}

// demoEnvironments are the seeded project's environments in display order.
var demoEnvironments = []demoEnvironment{
	{name: "production", production: true, color: "red"},
	{name: "staging", color: "yellow"},
	{name: "development", color: "blue"},
	{name: "preview", color: "purple", hidden: true},
}

// Demo API key names, one per state the API keys tab shows.
const (
	KeyActive   = "Checkout service"  // active, pinned to production
	KeyExpiring = "CI smoke tests"    // active, expires within the reminder window
	KeyRotating = "Edge gateway"      // rotated with a 7-day overlap: old key rotating, successor active
	KeyRevoked  = "Old laptop export" // revoked
)

// TeamOptions names the organization and project -with-team fills.
type TeamOptions struct {
	OrgSlug string
	// ProjectID is the project Seed created; it gets the environments and
	// the keys.
	ProjectID uuid.UUID
	// OwnerEmail is the dev owner: the actor of the access changes and of
	// the environment settings.
	OwnerEmail string
	Logger     *slog.Logger
}

// TeamResult is printed by `apilens seed -with-team`.
type TeamResult struct {
	Members           []TeamMember `json:"members"`
	RestrictedProject string       `json:"restricted_project"`
	Environments      []string     `json:"environments"`
	APIKeys           []string     `json:"api_keys"`
}

// SeedTeam adds the demo team, the restricted project, the environment
// settings and the API keys in every state to the organization o.OrgSlug,
// whose owner o.OwnerEmail must exist (EnsureMember). It is idempotent:
// members, grants, environments and settings that are already there are
// left alone, and a demo key is only created when the project has no key
// of that name.
func SeedTeam(ctx context.Context, pool *pgxpool.Pool, o TeamOptions) (TeamResult, error) {
	if o.Logger == nil {
		o.Logger = slog.New(slog.DiscardHandler)
	}
	owner, err := identitydb.New(pool).GetUserByEmail(ctx, o.OwnerEmail)
	if errors.Is(err, pgx.ErrNoRows) {
		return TeamResult{}, ErrUserNotFound
	}
	if err != nil {
		return TeamResult{}, fmt.Errorf("owner: %w", err)
	}
	people := map[string]uuid.UUID{}
	for _, m := range Team {
		res, err := EnsureMember(ctx, pool, MemberOptions{Email: m.Email, OrgSlug: o.OrgSlug, Role: m.Role, Create: true})
		if err != nil {
			return TeamResult{}, fmt.Errorf("member %s: %w", m.Email, err)
		}
		if err := ensureName(ctx, pool, res.UserID, m.Name); err != nil {
			return TeamResult{}, err
		}
		people[m.Email] = res.UserID
	}
	ada, eli, mia, val := people[Team[0].Email], people[Team[1].Email], people[Team[2].Email], people[Team[3].Email]

	recorder := audit.New(pool)
	projectSvc := projects.New(pool).WithAudit(recorder)
	envs, err := seedEnvironments(ctx, projectSvc, owner.ID, o.ProjectID)
	if err != nil {
		return TeamResult{}, err
	}

	keys := apikeys.NewService(pool, recorder, nil, o.Logger)
	keyNames, err := seedKeys(ctx, keys, o.ProjectID, owner.ID, ada, eli, mia)
	if err != nil {
		return TeamResult{}, err
	}

	restricted, err := seedRestrictedProject(ctx, projectSvc, owner.ID, o.OrgSlug)
	if err != nil {
		return TeamResult{}, err
	}
	accessSvc := access.New(pool).WithAudit(recorder)
	if _, err := accessSvc.SetDefault(ctx, owner.ID, restricted, access.DefaultNone, false); err != nil {
		return TeamResult{}, fmt.Errorf("restricted project default access: %w", err)
	}
	// Eli edits and Val views the restricted project through direct grants;
	// Mia has no grant, so she does not see it at all.
	for _, g := range []struct {
		user uuid.UUID
		role string
	}{{eli, "editor"}, {val, "viewer"}} {
		if _, err := accessSvc.Grant(ctx, owner.ID, restricted, g.user, g.role); err != nil {
			return TeamResult{}, fmt.Errorf("restricted project grant: %w", err)
		}
	}
	return TeamResult{
		Members: slices.Clone(Team), RestrictedProject: RestrictedProjectSlug, Environments: envs, APIKeys: keyNames,
	}, nil
}

// ensureName gives a demo user their name unless they already have one.
func ensureName(ctx context.Context, pool *pgxpool.Pool, id uuid.UUID, name string) error {
	q := identitydb.New(pool)
	u, err := q.GetUserByID(ctx, id)
	if err != nil {
		return fmt.Errorf("user: %w", err)
	}
	if u.Name != "" {
		return nil
	}
	if _, err := q.UpdateUserProfile(ctx, identitydb.UpdateUserProfileParams{ID: id, Name: &name}); err != nil {
		return fmt.Errorf("user name: %w", err)
	}
	return nil
}

// seedEnvironments adds the demo environments to project and sets their
// production flag, colour, hidden state and order. The services write and
// audit only what changes.
func seedEnvironments(ctx context.Context, svc *projects.Service, actor, project uuid.UUID) ([]string, error) {
	order := make([]string, 0, len(demoEnvironments))
	for _, e := range demoEnvironments {
		if _, err := svc.AddEnvironment(ctx, actor, project, e.name); err != nil {
			return nil, fmt.Errorf("environment %s: %w", e.name, err)
		}
		order = append(order, e.name)
	}
	if _, err := svc.ReorderEnvironments(ctx, actor, project, order); err != nil {
		return nil, fmt.Errorf("order environments: %w", err)
	}
	for _, e := range demoEnvironments {
		u := projects.EnvironmentUpdate{IsProduction: &e.production, Color: &e.color, Hidden: &e.hidden}
		if _, err := svc.UpdateEnvironment(ctx, actor, project, e.name, u); err != nil {
			return nil, fmt.Errorf("environment %s settings: %w", e.name, err)
		}
	}
	return order, nil
}

// seedKeys creates the demo keys of project that it does not have yet (by
// name), each by a different person, and returns their names.
func seedKeys(ctx context.Context, svc *apikeys.Service, project, owner, ada, eli, mia uuid.UUID) ([]string, error) {
	existing, err := svc.List(ctx, project)
	if err != nil {
		return nil, fmt.Errorf("list keys: %w", err)
	}
	has := func(name string) bool {
		return slices.ContainsFunc(existing, func(k apikeys.Key) bool { return k.Name == name })
	}
	ingest := []string{apikeys.ScopeIngest}
	if !has(KeyActive) {
		if _, err := svc.CreateKey(ctx, owner, project, apikeys.NewKey{
			Name: KeyActive, Scopes: ingest, Environments: []string{"production"},
		}); err != nil {
			return nil, fmt.Errorf("key %q: %w", KeyActive, err)
		}
	}
	if !has(KeyExpiring) {
		// Inside the expiry reminder window, so the tab shows it as expiring.
		expires := time.Now().Add(apikeys.ExpiryReminderWindow - 2*24*time.Hour)
		if _, err := svc.CreateKey(ctx, eli, project, apikeys.NewKey{
			Name: KeyExpiring, Scopes: ingest, ExpiresAt: &expires, Environments: []string{"staging"},
		}); err != nil {
			return nil, fmt.Errorf("key %q: %w", KeyExpiring, err)
		}
	}
	if !has(KeyRotating) {
		k, err := svc.CreateKey(ctx, ada, project, apikeys.NewKey{Name: KeyRotating, Scopes: ingest})
		if err != nil {
			return nil, fmt.Errorf("key %q: %w", KeyRotating, err)
		}
		if _, err := svc.Rotate(ctx, ada, project, k.ID, apikeys.Overlap7d); err != nil {
			return nil, fmt.Errorf("rotate key %q: %w", KeyRotating, err)
		}
	}
	if !has(KeyRevoked) {
		k, err := svc.CreateKey(ctx, mia, project, apikeys.NewKey{Name: KeyRevoked, Scopes: []string{apikeys.ScopeRead}})
		if err != nil {
			return nil, fmt.Errorf("key %q: %w", KeyRevoked, err)
		}
		if err := svc.Revoke(ctx, ada, project, k.ID); err != nil {
			return nil, fmt.Errorf("revoke key %q: %w", KeyRevoked, err)
		}
	}
	return []string{KeyActive, KeyExpiring, KeyRotating, KeyRevoked}, nil
}

// seedRestrictedProject returns the id of the organization's restricted demo
// project, creating it (with production and staging) on behalf of owner
// when the organization does not have it.
func seedRestrictedProject(ctx context.Context, svc *projects.Service, owner uuid.UUID, orgSlug string) (uuid.UUID, error) {
	list, err := svc.List(ctx, owner, orgSlug)
	if err != nil {
		return uuid.Nil, fmt.Errorf("list projects: %w", err)
	}
	id := uuid.Nil
	for _, p := range list {
		if p.Slug == RestrictedProjectSlug {
			id = p.ID
		}
	}
	if id == uuid.Nil {
		p, err := svc.Create(ctx, owner, orgSlug, "Payments", RestrictedProjectSlug, []string{"production", "staging"})
		if err != nil {
			return uuid.Nil, fmt.Errorf("restricted project: %w", err)
		}
		id = p.ID
	}
	prod, red := true, "red"
	if _, err := svc.UpdateEnvironment(ctx, owner, id, "production", projects.EnvironmentUpdate{IsProduction: &prod, Color: &red}); err != nil {
		return uuid.Nil, fmt.Errorf("restricted project environment: %w", err)
	}
	return id, nil
}
