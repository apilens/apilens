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
// Capabilities come from SpiceDB: every (permission, resource) pair the
// vocabulary needs for the user's projects and their organizations is asked
// in one CheckBulkPermissions call, so a context read is at most one SpiceDB
// round trip whatever the number of projects. The action → permission table
// is Vocabulary (docs/architecture/identity.md, authz/README.md).
package usercontext

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/apilens/apilens/internal/authz"
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
	ActionCaptureManage = "capture.manage"
	ActionAlertsManage  = "alerts.manage"
	ActionMembersInvite = "members.invite"
	ActionMembersRemove = "members.remove"
	ActionBillingManage = "billing.manage"
)

// Grant is one action of the vocabulary and the SpiceDB permission that
// decides it, checked on the project or on the project's organization.
type Grant struct {
	Action     string
	Permission authz.Permission
	// OnOrg checks Permission on the project's organization instead of on
	// the project itself.
	OnOrg bool
}

// Vocabulary is the capabilities vocabulary in response order. Each action
// resolves to exactly one SpiceDB permission (authz/README.md); keep it in
// step with docs/architecture/identity.md and apps/ui/src/lib/capabilities.ts.
var Vocabulary = []Grant{
	{ActionProjectRead, authz.ProjectView, false},
	{ActionProjectUpdate, authz.ProjectEdit, false},
	{ActionProjectDelete, authz.ProjectDelete, false},
	{ActionAPIKeysCreate, authz.ProjectManageKeys, false},
	{ActionAPIKeysRevoke, authz.ProjectManageKeys, false},
	{ActionCaptureManage, authz.ProjectManageCapture, false},
	{ActionAlertsManage, authz.ProjectManageAlerts, false},
	{ActionMembersInvite, authz.OrgInvite, true},
	{ActionMembersRemove, authz.OrgManageMembers, true},
	{ActionBillingManage, authz.OrgManageBilling, true},
}

// Checker answers many permission checks in one SpiceDB round trip;
// *authz.Client satisfies it.
type Checker interface {
	CheckBulk(ctx context.Context, items []authz.CheckItem) ([]bool, error)
}

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
	// perform, in Vocabulary order. Every project of Orgs has an entry.
	Capabilities map[string][]string
}

// Service reads user contexts.
type Service struct {
	pool    *pgxpool.Pool
	checker Checker
}

// New returns a Service over pool that asks checker for capabilities.
func New(pool *pgxpool.Pool, checker Checker) *Service {
	return &Service{pool: pool, checker: checker}
}

// Get returns the context of user, or ErrNotFound when the user is gone.
// When SpiceDB cannot answer every capability check the error wraps
// authz.ErrUnavailable: capabilities are never partial (fail closed).
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

	out := Context{User: u, Orgs: make([]Org, 0, len(orgRows))}
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
		if p.Slug == last {
			out.LastProjectSlug = last
		}
	}
	caps, err := s.capabilities(ctx, user, out.Orgs)
	if err != nil {
		return Context{}, err
	}
	out.Capabilities = caps
	return out, nil
}

// capabilities resolves Vocabulary for every project of orgs with one
// CheckBulk call (none when there are no projects). Each distinct
// (permission, resource) pair is asked once: the organization permissions
// once per organization, manage_keys once per project.
func (s *Service) capabilities(ctx context.Context, user uuid.UUID, orgs []Org) (map[string][]string, error) {
	type pair struct {
		permission authz.Permission
		resource   authz.Object
	}
	subject := authz.User(user.String())
	index := map[pair]int{}
	var items []authz.CheckItem
	ask := func(permission authz.Permission, resource authz.Resource) int {
		k := pair{permission, resource.Object}
		if i, ok := index[k]; ok {
			return i
		}
		index[k] = len(items)
		items = append(items, authz.CheckItem{Subject: subject, Permission: permission, Resource: resource})
		return index[k]
	}
	// slots[project slug][j] indexes the item answering Vocabulary[j].
	slots := map[string][]int{}
	for _, o := range orgs {
		org := authz.Organization(o.ID.String())
		for _, p := range o.Projects {
			project := authz.Project(o.ID.String(), p.ID.String())
			slot := make([]int, len(Vocabulary))
			for j, g := range Vocabulary {
				if g.OnOrg {
					slot[j] = ask(g.Permission, org)
				} else {
					slot[j] = ask(g.Permission, project)
				}
			}
			slots[p.Slug] = slot
		}
	}

	out := make(map[string][]string, len(slots))
	if len(items) == 0 {
		return out, nil
	}
	allowed, err := s.checker.CheckBulk(ctx, items)
	if err != nil {
		return nil, fmt.Errorf("usercontext: capabilities: %w", err)
	}
	for slug, slot := range slots {
		actions := []string{}
		for j, g := range Vocabulary {
			if allowed[slot[j]] {
				actions = append(actions, g.Action)
			}
		}
		out[slug] = actions
	}
	return out, nil
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
