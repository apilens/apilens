package authz

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/hashicorp/golang-lru/v2/expirable"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/identity"
	"github.com/apilens/apilens/internal/platform/authn"
)

// Path parameters a Guard reads the resource from. The organization is
// {org}, or {slug} when there is no {org}; the project is {project}, or
// {slug} when {org} names the organization.
const (
	ParamOrg     = "org"
	ParamProject = "project"
	ParamSlug    = "slug"
)

// ErrNoResource is returned by a Resolver for a slug that names no active
// organization or project.
var ErrNoResource = errors.New("authz: no such resource")

// Checker answers permission checks; *Client satisfies it.
type Checker interface {
	Check(ctx context.Context, subject Object, permission Permission, resource Resource) (bool, error)
}

// Resolver turns slugs from request paths into ids. Both methods return
// ErrNoResource for a slug that names nothing active.
type Resolver interface {
	OrgID(ctx context.Context, slug string) (uuid.UUID, error)
	Project(ctx context.Context, slug string) (id, org uuid.UUID, err error)
}

// PGResolver resolves slugs from the control-plane tables.
type PGResolver struct {
	q *db.Queries
}

// NewPGResolver returns a Resolver over pool.
func NewPGResolver(pool *pgxpool.Pool) *PGResolver { return &PGResolver{q: db.New(pool)} }

// OrgID implements Resolver.
func (r *PGResolver) OrgID(ctx context.Context, slug string) (uuid.UUID, error) {
	o, err := r.q.GetOrganizationBySlug(ctx, slug)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, ErrNoResource
	}
	if err != nil {
		return uuid.Nil, fmt.Errorf("authz: resolve organization: %w", err)
	}
	return o.ID, nil
}

// Project implements Resolver.
func (r *PGResolver) Project(ctx context.Context, slug string) (uuid.UUID, uuid.UUID, error) {
	p, err := r.q.ResolveProjectSlug(ctx, slug)
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, uuid.Nil, ErrNoResource
	}
	if err != nil {
		return uuid.Nil, uuid.Nil, fmt.Errorf("authz: resolve project: %w", err)
	}
	return p.ID, p.OrgID, nil
}

// GuardOptions tunes a Guard.
type GuardOptions struct {
	// SlugTTL bounds how long a slug → id lookup is reused. Default 30s.
	// A denial on a cached id is retried with a fresh lookup, so a slug
	// that moved to a new organization is never refused for long.
	SlugTTL time.Duration
	// SlugCacheSize caps the cached lookups. Default 10000.
	SlugCacheSize int
}

// Guard authorizes typed API operations on the organization or project
// their path names. Install it per operation with Require.
type Guard struct {
	checker  Checker
	resolver Resolver
	logger   *slog.Logger
	slugs    *expirable.LRU[string, target]
}

// target is a resolved organization or project.
type target struct {
	org, project uuid.UUID
}

// Target is what a Guard resolved for the request, read by handlers with
// TargetFromContext.
type Target struct {
	OrgID     uuid.UUID
	ProjectID uuid.UUID // uuid.Nil for an organization resource
}

type targetKey struct{}

// TargetFromContext returns the organization (and project) a Guard
// authorized the request for.
func TargetFromContext(ctx context.Context) (Target, bool) {
	t, ok := ctx.Value(targetKey{}).(Target)
	return t, ok
}

// NewGuard returns a Guard asking checker about the resources resolver
// finds. logger may be nil.
func NewGuard(checker Checker, resolver Resolver, opts GuardOptions, logger *slog.Logger) *Guard {
	if opts.SlugTTL <= 0 {
		opts.SlugTTL = 30 * time.Second
	}
	if opts.SlugCacheSize <= 0 {
		opts.SlugCacheSize = 10_000
	}
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return &Guard{
		checker:  checker,
		resolver: resolver,
		logger:   logger,
		slugs:    expirable.NewLRU[string, target](opts.SlugCacheSize, nil, opts.SlugTTL),
	}
}

// RequireOrg is Require on the organization the path names.
func (g *Guard) RequireOrg(api huma.API, permission Permission) func(huma.Context, func(huma.Context)) {
	return g.Require(api, TypeOrganization, permission)
}

// RequireProject is Require on the project the path names.
func (g *Guard) RequireProject(api huma.API, permission Permission) func(huma.Context, func(huma.Context)) {
	return g.Require(api, TypeProject, permission)
}

// Require returns an operation middleware that lets the request through only
// when the principal has permission on the resourceType (TypeOrganization or
// TypeProject) object named by the path. It must run after authentication.
//
// Answers, all as identity problems:
//   - not_found (404): no such active resource, or the caller cannot view
//     it. The two are indistinguishable, so existence never leaks.
//   - forbidden (403): the caller can view the resource but lacks
//     permission.
//   - authz_unavailable (503): SpiceDB could not answer (fail closed).
//
// Users are checked against SpiceDB. API keys only ever satisfy view on
// their own project; OAuth clients hold no grants. A nil Guard refuses
// every request with authz_unavailable.
func (g *Guard) Require(api huma.API, resourceType string, permission Permission) func(huma.Context, func(huma.Context)) {
	if resourceType != TypeOrganization && resourceType != TypeProject {
		panic("authz: Require on unknown resource type " + resourceType)
	}
	return func(ctx huma.Context, next func(huma.Context)) {
		if g == nil {
			writeProblem(api, ctx, identity.ErrRetryAfter(identity.CodeAuthzUnavailable, time.Second))
			return
		}
		p, ok := authn.FromContext(ctx.Context())
		if !ok {
			writeProblem(api, ctx, identity.Err(identity.CodeUnauthenticated))
			return
		}
		t, err := g.authorize(ctx, p, resourceType, permission)
		switch {
		case err == nil:
			c := context.WithValue(ctx.Context(), targetKey{}, Target{OrgID: t.org, ProjectID: t.project})
			next(huma.WithContext(ctx, c))
		case errors.Is(err, errHidden), errors.Is(err, ErrNoResource):
			writeProblem(api, ctx, identity.Err(identity.CodeNotFound))
		case errors.Is(err, errForbidden):
			writeProblem(api, ctx, identity.Err(identity.CodeForbidden))
		case errors.Is(err, ErrUnavailable):
			writeProblem(api, ctx, identity.ErrRetryAfter(identity.CodeAuthzUnavailable, time.Second))
		default:
			g.logger.ErrorContext(ctx.Context(), "authorize request", "error", err)
			writeProblem(api, ctx, identity.Err(identity.CodeInternal))
		}
	}
}

// Outcomes of decide besides allowed (nil) and ErrUnavailable.
var (
	errHidden    = errors.New("authz: hidden")
	errForbidden = errors.New("authz: forbidden")
)

// authorize resolves the path's resource and decides. A refusal on a cached
// lookup is retried once with a fresh one, in case the slug now names a
// different resource (deleted and re-created).
func (g *Guard) authorize(ctx huma.Context, p authn.Principal, typ string, perm Permission) (target, error) {
	key, orgSlug, err := g.slugKey(ctx, typ)
	if err != nil {
		return target{}, err
	}
	return g.authorizeKey(ctx.Context(), p, typ, perm, key, orgSlug)
}

// authorizeKey is authorize on an already-built cache key.
func (g *Guard) authorizeKey(ctx context.Context, p authn.Principal, typ string, perm Permission, key, orgSlug string) (target, error) {
	t, cached, err := g.resolve(ctx, typ, key, orgSlug)
	if err != nil {
		return t, err
	}
	err = g.decide(ctx, p, typ, perm, t)
	if err == nil || !cached || errors.Is(err, ErrUnavailable) {
		return t, err
	}
	g.slugs.Remove(key)
	fresh, _, rerr := g.resolve(ctx, typ, key, orgSlug)
	if rerr != nil {
		return fresh, rerr
	}
	if fresh == t {
		return t, err
	}
	return fresh, g.decide(ctx, p, typ, perm, fresh)
}

// ErrForbidden is returned by AuthorizeProject when the caller can view the
// project but lacks the permission asked for.
var ErrForbidden = errors.New("authz: forbidden")

// AuthorizeProject is Require for a project named outside the path (for
// example a query parameter): it resolves slug and checks permission for p
// with the same rules. It returns ErrNoResource when the project does not
// exist or p cannot view it (indistinguishable on purpose), ErrForbidden
// when p can view it but lacks permission, and an error wrapping
// ErrUnavailable when SpiceDB cannot answer (fail closed). A nil Guard
// answers ErrUnavailable.
func (g *Guard) AuthorizeProject(ctx context.Context, p authn.Principal, slug string, permission Permission) (Target, error) {
	if g == nil {
		return Target{}, ErrUnavailable
	}
	if slug == "" {
		return Target{}, ErrNoResource
	}
	t, err := g.authorizeKey(ctx, p, TypeProject, permission, TypeProject+":"+slug, "")
	switch {
	case err == nil:
		return Target{OrgID: t.org, ProjectID: t.project}, nil
	case errors.Is(err, errHidden):
		return Target{}, ErrNoResource
	case errors.Is(err, errForbidden):
		return Target{}, ErrForbidden
	default:
		return Target{}, err
	}
}

// slugKey reads the resource's slug from the path. It returns the cache
// key, and for a project the organization slug the path also names ("" if
// none).
func (g *Guard) slugKey(ctx huma.Context, typ string) (key, orgSlug string, err error) {
	org := ctx.Param(ParamOrg)
	if typ == TypeOrganization {
		if org == "" {
			org = ctx.Param(ParamSlug)
		}
		if org == "" {
			return "", "", ErrNoResource
		}
		return TypeOrganization + ":" + org, "", nil
	}
	project := ctx.Param(ParamProject)
	switch {
	case project != "" && org == "":
		org = ctx.Param(ParamSlug)
	case project == "" && org != "":
		project = ctx.Param(ParamSlug)
	}
	if project == "" {
		return "", "", ErrNoResource
	}
	return TypeProject + ":" + project, org, nil
}

// resolve looks the resource up, through the cache. cached reports whether
// the answer came from the cache.
func (g *Guard) resolve(ctx context.Context, typ, key, orgSlug string) (t target, cached bool, err error) {
	t, cached = g.slugs.Get(key)
	if !cached {
		slug := key[len(typ)+1:]
		if typ == TypeOrganization {
			t.org, err = g.resolver.OrgID(ctx, slug)
		} else {
			t.project, t.org, err = g.resolver.Project(ctx, slug)
		}
		if err != nil {
			return target{}, false, err
		}
		g.slugs.Add(key, t)
	}
	if orgSlug != "" {
		// The project must belong to the organization the path names.
		orgKey := TypeOrganization + ":" + orgSlug
		o, ocached, err := g.resolve(ctx, TypeOrganization, orgKey, "")
		if err != nil {
			return target{}, false, err
		}
		if o.org != t.org {
			return target{}, false, ErrNoResource
		}
		cached = cached || ocached
	}
	return t, cached, nil
}

// decide answers whether p has perm on t: nil, errHidden, errForbidden or
// an error wrapping ErrUnavailable.
func (g *Guard) decide(ctx context.Context, p authn.Principal, typ string, perm Permission, t target) error {
	switch p.Kind {
	case authn.KindUser:
		subject := User(p.UserID.String())
		res := Organization(t.org.String())
		view := OrgView
		if typ == TypeProject {
			res, view = Project(t.org.String(), t.project.String()), ProjectView
		}
		ok, err := g.checker.Check(ctx, subject, perm, res)
		if err != nil {
			return err
		}
		if ok {
			return nil
		}
		if perm == view {
			return errHidden
		}
		// Only callers who can see the resource learn that it exists.
		canView, err := g.checker.Check(ctx, subject, view, res)
		switch {
		case err != nil:
			return err
		case canView:
			return errForbidden
		default:
			return errHidden
		}
	case authn.KindAPIKey:
		// An API key is bound to one project and may only read it; it never
		// satisfies organization permissions.
		switch {
		case typ == TypeProject && t.project == p.ProjectID && perm == ProjectView:
			return nil
		case typ == TypeProject && t.project == p.ProjectID, typ == TypeOrganization && t.org == p.OrgID:
			return errForbidden
		default:
			return errHidden
		}
	default:
		return errHidden
	}
}

// writeProblem writes p as the response, as a handler returning it would.
func writeProblem(api huma.API, ctx huma.Context, p *identity.Problem) {
	for name, values := range p.GetHeaders() {
		for _, v := range values {
			ctx.SetHeader(name, v)
		}
	}
	ctx.SetHeader("Content-Type", identity.ProblemContentType)
	ctx.SetStatus(p.Status)
	_ = api.Marshal(ctx.BodyWriter(), identity.ProblemContentType, p)
}
