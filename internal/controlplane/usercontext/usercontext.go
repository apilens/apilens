// Package usercontext assembles what the UI shell needs about the signed-in
// user in one read: the user, their organizations with their role, each
// organization's projects and environments, the last project they opened and
// the actions they may perform per project. It backs
// GET /api/v1/users/me/context.
//
// The read is a fixed number of indexed queries whatever the number of
// organizations and projects (memberships_user, projects_org and the
// environments (project_id, name) key), run in one read-only snapshot so the
// organizations, projects and environments agree with each other.
//
// Capabilities are derived from the organization role until the SpiceDB
// CheckBulk version lands (#294); the mapping follows the role → action table
// of authz/README.md, asserted by authz/schema.validation.yaml.
package usercontext

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/apilens/apilens/internal/controlplane/orgs"
	"github.com/apilens/apilens/internal/controlplane/projects"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/identity/account"
)

// Actions of the capabilities vocabulary (docs/architecture/identity.md).
const (
	ActionProjectRead   = "project.read"
	ActionProjectUpdate = "project.update"
	ActionProjectDelete = "project.delete"
	ActionAPIKeysCreate = "api_keys.create"
	ActionAPIKeysRevoke = "api_keys.revoke"
	ActionMembersInvite = "members.invite"
	ActionMembersRemove = "members.remove"
	ActionBillingManage = "billing.manage"
)

// ErrNotFound means the user does not exist or is deleted.
var ErrNotFound = errors.New("usercontext: user not found")

// Project is a project of one of the user's organizations.
type Project struct {
	ID           uuid.UUID
	Slug         string
	Name         string
	Environments []string // sorted, never nil
}

// Org is an organization the user belongs to, with their role in it.
type Org struct {
	ID       uuid.UUID
	Slug     string
	Name     string
	Role     string
	Projects []Project // by name, never nil
}

// Context is the signed-in user's context.
type Context struct {
	User db.User
	Orgs []Org // by name
	// LastProjectSlug is the user's last_project_slug preference when it
	// names a project they can still see; empty otherwise.
	LastProjectSlug string
	// Capabilities lists, per project slug, the actions the user may
	// perform. Every project of Orgs has an entry.
	Capabilities map[string][]string
}

// Service reads user contexts.
type Service struct {
	pool *pgxpool.Pool
}

// New returns a Service over pool.
func New(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

// Get returns the context of user, or ErrNotFound when the user is gone.
func (s *Service) Get(ctx context.Context, user uuid.UUID) (Context, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Context{}, fmt.Errorf("usercontext: begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := db.New(tx)

	u, err := q.GetContextUser(ctx, user)
	if errors.Is(err, pgx.ErrNoRows) {
		return Context{}, ErrNotFound
	}
	if err != nil {
		return Context{}, fmt.Errorf("usercontext: get user: %w", err)
	}
	orgRows, err := q.ListUserOrganizations(ctx, user)
	if err != nil {
		return Context{}, fmt.Errorf("usercontext: list organizations: %w", err)
	}
	projectRows, err := q.ListUserProjects(ctx, user)
	if err != nil {
		return Context{}, fmt.Errorf("usercontext: list projects: %w", err)
	}
	ids := make([]uuid.UUID, 0, len(projectRows))
	for _, p := range projectRows {
		ids = append(ids, p.ID)
	}
	envs := map[uuid.UUID][]string{}
	if len(ids) > 0 {
		rows, err := q.ListProjectsEnvironments(ctx, ids)
		if err != nil {
			return Context{}, fmt.Errorf("usercontext: list environments: %w", err)
		}
		for _, r := range rows {
			envs[r.ProjectID] = append(envs[r.ProjectID], r.Name)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Context{}, fmt.Errorf("usercontext: commit: %w", err)
	}

	out := Context{User: u, Orgs: make([]Org, 0, len(orgRows)), Capabilities: map[string][]string{}}
	index := make(map[uuid.UUID]int, len(orgRows))
	for _, o := range orgRows {
		index[o.ID] = len(out.Orgs)
		out.Orgs = append(out.Orgs, Org{ID: o.ID, Slug: o.Slug, Name: o.Name, Role: o.Role, Projects: []Project{}})
	}
	last := lastProject(u.Preferences)
	for _, p := range projectRows {
		i, ok := index[p.OrgID]
		if !ok {
			continue // the organization went away between the two reads
		}
		e := envs[p.ID]
		if e == nil {
			e = []string{}
		}
		org := &out.Orgs[i]
		org.Projects = append(org.Projects, Project{ID: p.ID, Slug: p.Slug, Name: p.Name, Environments: e})
		out.Capabilities[p.Slug] = Actions(org.Role)
		if p.Slug == last {
			out.LastProjectSlug = last
		}
	}
	return out, nil
}

// Actions returns the actions an organization role grants on each project of
// the organization, in vocabulary order. An unknown role grants nothing.
func Actions(role string) []string {
	out := []string{}
	if !slices.Contains(orgs.Roles, role) {
		return out
	}
	out = append(out, ActionProjectRead)
	if projects.CanWrite(role) {
		out = append(out, ActionProjectUpdate)
	}
	if projects.CanDelete(role) {
		out = append(out, ActionProjectDelete)
	}
	if projects.CanWrite(role) {
		out = append(out, ActionAPIKeysCreate, ActionAPIKeysRevoke)
	}
	if orgs.CanManage(role) {
		out = append(out, ActionMembersInvite, ActionMembersRemove)
	}
	if role == orgs.RoleOwner {
		out = append(out, ActionBillingManage)
	}
	return out
}

// lastProject reads the last_project_slug preference; empty when unset or
// unreadable.
func lastProject(prefs []byte) string {
	var p map[string]any
	if json.Unmarshal(prefs, &p) != nil {
		return ""
	}
	s, _ := p[account.PreferenceLastProject].(string)
	return s
}
