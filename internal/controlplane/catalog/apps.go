// Package catalog resolves the app names SDKs send (app UUID, slug or a free
// form name such as "Orders API") to app IDs within a project, with a small
// per-project cache. Names it has not seen create the app (apps.Provisioner)
// when the key may; records without a name go to the project's default app.
package catalog

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"golang.org/x/sync/singleflight"

	"github.com/apilens/apilens/internal/controlplane/apps"
	"github.com/apilens/apilens/internal/controlplane/store/db"
)

// AppLister is the store subset the resolver needs.
type AppLister interface {
	ListResolverApps(ctx context.Context, arg db.ListResolverAppsParams) ([]db.ListResolverAppsRow, error)
	ListProjectAppAliases(ctx context.Context, projectID uuid.UUID) ([]db.ListProjectAppAliasesRow, error)
}

// Provisioner creates and un-archives apps; *apps.Provisioner satisfies it.
type Provisioner interface {
	Create(ctx context.Context, projectID, keyID uuid.UUID, slug, name string) (uuid.UUID, bool, error)
	EnsureDefault(ctx context.Context, projectID uuid.UUID) (uuid.UUID, error)
	Unarchive(ctx context.Context, projectID, appID, keyID uuid.UUID) error
}

// UnknownAppsError lists identifiers that matched no app in the project.
type UnknownAppsError struct{ Identifiers []string }

func (e *UnknownAppsError) Error() string {
	return "unknown app_id(s): " + strings.Join(e.Identifiers, ", ")
}

// Caller is the API key records arrive with.
type Caller struct {
	KeyID       uuid.UUID
	ProjectSlug string
	// CanCreate: the key carries the apps:create scope.
	CanCreate bool
	// AppIDs limits the key to these apps; nil allows every app. A scoped
	// key never creates apps.
	AppIDs []uuid.UUID
	// LookupOnly resolves known apps and reports the rest as rejected
	// without creating or un-archiving anything (quota accounting).
	LookupOnly bool
}

// Reasons records are rejected for an app.
const (
	ReasonCreateForbidden = "app_create_forbidden" // unknown app, the key may not create apps
	ReasonNotAllowed      = "app_not_allowed"      // the key is limited to other apps
	ReasonDeleted         = "app_deleted"          // the app was deleted less than 30 days ago
	ReasonAppLimit        = "app_limit"            // ingest.max_apps_per_project reached
	ReasonRateLimit       = "app_rate_limit"       // ingest.max_new_apps_per_hour reached
	ReasonInvalidName     = "invalid_app_name"     // nothing usable left after normalisation
	ReasonUnknown         = "unknown_app"          // an app id that matches no app (or LookupOnly)
)

// Reasons lists every rejection reason, in documentation order.
var Reasons = []string{ReasonCreateForbidden, ReasonNotAllowed, ReasonDeleted, ReasonAppLimit, ReasonRateLimit, ReasonInvalidName, ReasonUnknown}

// Rejection is why the records naming one identifier are refused.
type Rejection struct {
	Slug    string    // the normalised slug ("" when the name is unusable)
	Reason  string    // one of the Reason constants
	Message string    // human-readable, names the app and what to do
	AppID   uuid.UUID // the existing app, for ReasonNotAllowed
}

// Result maps each identifier of a call to an app or a rejection. The empty
// identifier stands for records that named no app.
type Result struct {
	Apps     map[string]uuid.UUID
	Rejected map[string]Rejection
	// Created lists the apps this call created.
	Created []uuid.UUID
}

type appEntry struct {
	id         uuid.UUID
	slug       string
	archived   bool
	mergedInto *uuid.UUID
}

type projectApps struct {
	byID      map[uuid.UUID]appEntry // active and archived apps
	bySlug    map[string]appEntry
	aliases   map[string]uuid.UUID
	deleted   map[string]time.Time // recently deleted slugs no active app uses
	defaultID uuid.UUID
	loadedAt  time.Time
}

// AppResolver caches each project's apps for ttl. Unknown identifiers force
// one refresh (rate-limited by minRefresh) so apps created elsewhere are
// picked up without waiting for the TTL; apps this process creates or
// un-archives refresh the cache at once.
type AppResolver struct {
	store      AppLister
	prov       Provisioner // nil: unknown apps are rejected
	ttl        time.Duration
	minRefresh time.Duration
	negTTL     time.Duration
	now        func() time.Time

	mu    sync.RWMutex
	cache map[uuid.UUID]*projectApps
	group singleflight.Group

	negMu sync.Mutex
	neg   map[string]negEntry // project/slug -> limit rejection, briefly
}

type negEntry struct {
	r     Rejection
	until time.Time
}

// NewAppResolver builds a resolver that only resolves existing apps.
func NewAppResolver(store AppLister, ttl time.Duration) *AppResolver {
	return &AppResolver{
		store: store, ttl: ttl, minRefresh: 2 * time.Second, negTTL: 30 * time.Second, now: time.Now,
		cache: map[uuid.UUID]*projectApps{}, neg: map[string]negEntry{},
	}
}

// WithProvisioner lets the resolver create apps, the default app and
// un-archive apps through prov.
func (r *AppResolver) WithProvisioner(prov Provisioner) *AppResolver {
	r.prov = prov
	return r
}

// Resolve maps every identifier to an existing app ID without creating
// anything. It reports identifiers it cannot match as *UnknownAppsError.
func (r *AppResolver) Resolve(ctx context.Context, projectID uuid.UUID, identifiers []string) (map[string]uuid.UUID, error) {
	res, err := r.ResolveFor(ctx, projectID, Caller{LookupOnly: true}, identifiers)
	if err != nil {
		return nil, err
	}
	if len(res.Rejected) > 0 {
		missing := make([]string, 0, len(res.Rejected))
		for id := range res.Rejected {
			missing = append(missing, id)
		}
		sort.Strings(missing)
		return nil, &UnknownAppsError{Identifiers: missing}
	}
	return res.Apps, nil
}

// ResolveFor maps the identifiers of one ingest call for caller. Each
// identifier (trimmed) ends in Result.Apps or Result.Rejected; the error is
// for the catalog being unavailable only.
//
// In order: "" is the project's default app (created when missing); a UUID
// or the normalised slug of an app, an alias of a merged app, or an
// archived app (un-archived) match an app; a slug of an app deleted in the
// last 30 days is rejected; anything else creates the app when the caller
// may. Apps outside the caller's app scope are rejected.
func (r *AppResolver) ResolveFor(ctx context.Context, projectID uuid.UUID, c Caller, identifiers []string) (Result, error) {
	res := Result{Apps: map[string]uuid.UUID{}, Rejected: map[string]Rejection{}}
	idents := distinct(identifiers)
	if len(idents) == 0 {
		return res, nil
	}
	pa, err := r.get(ctx, projectID, false)
	if err != nil {
		return res, err
	}
	if r.unresolved(pa, idents) && time.Since(pa.loadedAt) >= r.minRefresh {
		if pa, err = r.get(ctx, projectID, true); err != nil {
			return res, err
		}
	}
	changed := false
	made := map[string]uuid.UUID{} // slugs created by this call
	for _, ident := range idents {
		id, ok, rej, err := r.one(ctx, projectID, pa, c, ident, &res, &changed, made)
		if err != nil {
			return res, err
		}
		if !ok {
			res.Rejected[ident] = rej
			continue
		}
		if c.AppIDs != nil && !slices.Contains(c.AppIDs, id) {
			res.Rejected[ident] = Rejection{Slug: pa.slugOf(id, ident), Reason: ReasonNotAllowed, AppID: id,
				Message: fmt.Sprintf("this API key is limited to some apps and may not send data for app %q; add the app to the key's app list in Project settings → API keys", pa.slugOf(id, ident))}
			continue
		}
		res.Apps[ident] = id
	}
	if changed {
		if _, err := r.get(ctx, projectID, true); err != nil {
			return res, err
		}
	}
	return res, nil
}

func (pa *projectApps) slugOf(id uuid.UUID, fallback string) string {
	if e, ok := pa.byID[id]; ok {
		return e.slug
	}
	return fallback
}

// unresolved reports whether some identifier matches nothing in pa.
func (r *AppResolver) unresolved(pa *projectApps, idents []string) bool {
	for _, ident := range idents {
		if ident == "" {
			if pa.defaultID == uuid.Nil {
				return true
			}
			continue
		}
		if _, ok := pa.match(ident); !ok {
			return true
		}
	}
	return false
}

// match finds the app an identifier names, following merges.
func (pa *projectApps) match(ident string) (appEntry, bool) {
	var e appEntry
	found := false
	if id, err := uuid.Parse(ident); err == nil {
		e, found = pa.byID[id]
	}
	if !found {
		slug, ok := apps.Normalize(ident)
		if !ok {
			return appEntry{}, false
		}
		if target, ok := pa.aliases[slug]; ok {
			e, found = pa.byID[target]
		}
		if !found {
			e, found = pa.bySlug[slug]
		}
	}
	for i := 0; found && e.mergedInto != nil && i < 8; i++ {
		e, found = pa.byID[*e.mergedInto]
	}
	return e, found
}

func (r *AppResolver) one(ctx context.Context, projectID uuid.UUID, pa *projectApps, c Caller, ident string, res *Result, changed *bool, made map[string]uuid.UUID) (uuid.UUID, bool, Rejection, error) {
	if ident == "" {
		if pa.defaultID != uuid.Nil {
			return pa.defaultID, true, Rejection{}, nil
		}
		if c.LookupOnly || r.prov == nil {
			return uuid.Nil, false, Rejection{Reason: ReasonUnknown, Message: "the project has no default app"}, nil
		}
		id, err := r.prov.EnsureDefault(ctx, projectID)
		if err != nil {
			return uuid.Nil, false, Rejection{}, fmt.Errorf("catalog: default app: %w", err)
		}
		*changed = true
		return id, true, Rejection{}, nil
	}
	if e, ok := pa.match(ident); ok {
		if e.archived && !c.LookupOnly && r.prov != nil {
			if err := r.prov.Unarchive(ctx, projectID, e.id, c.KeyID); err != nil {
				return uuid.Nil, false, Rejection{}, fmt.Errorf("catalog: unarchive app: %w", err)
			}
			*changed = true
		}
		return e.id, true, Rejection{}, nil
	}
	if _, err := uuid.Parse(ident); err == nil {
		// An app id is never a name to create an app from.
		return uuid.Nil, false, Rejection{Reason: ReasonUnknown,
			Message: fmt.Sprintf("no app has the id %s in project %s; send the app name instead", ident, c.ProjectSlug)}, nil
	}
	slug, ok := apps.Normalize(ident)
	if !ok {
		return uuid.Nil, false, Rejection{Reason: ReasonInvalidName,
			Message: fmt.Sprintf("%q is not a usable app name: use letters, digits, spaces, '-' or '_'", ident)}, nil
	}
	if at, ok := pa.deleted[slug]; ok {
		return uuid.Nil, false, deletedRejection(slug, at), nil
	}
	switch {
	case c.LookupOnly:
		return uuid.Nil, false, Rejection{Slug: slug, Reason: ReasonUnknown, Message: fmt.Sprintf("unknown app %q", slug)}, nil
	case c.AppIDs != nil:
		return uuid.Nil, false, Rejection{Slug: slug, Reason: ReasonNotAllowed,
			Message: fmt.Sprintf("app %q does not exist in project %s and this API key is limited to some apps, so it cannot create apps; create the app from Apps or send data for one of the key's apps", slug, c.ProjectSlug)}, nil
	case !c.CanCreate || r.prov == nil:
		return uuid.Nil, false, Rejection{Slug: slug, Reason: ReasonCreateForbidden,
			Message: fmt.Sprintf("app %q does not exist in project %s and this API key cannot create apps; turn on \"Can create apps\" for the key in Project settings → API keys, or send an existing app name", slug, c.ProjectSlug)}, nil
	}
	if id, ok := made[slug]; ok {
		return id, true, Rejection{}, nil
	}
	negKey := projectID.String() + "/" + slug
	if rej, ok := r.negative(negKey); ok {
		return uuid.Nil, false, rej, nil
	}
	id, created, err := r.prov.Create(ctx, projectID, c.KeyID, slug, apps.DisplayName(ident))
	var limit *apps.LimitError
	var deleted *apps.DeletedError
	switch {
	case errors.As(err, &limit):
		rej := limitRejection(slug, c.ProjectSlug, limit)
		r.remember(negKey, rej)
		return uuid.Nil, false, rej, nil
	case errors.As(err, &deleted):
		return uuid.Nil, false, deletedRejection(slug, deleted.DeletedAt), nil
	case err != nil:
		return uuid.Nil, false, Rejection{}, fmt.Errorf("catalog: create app: %w", err)
	}
	made[slug] = id
	if created {
		res.Created = append(res.Created, id)
	}
	*changed = true
	return id, true, Rejection{}, nil
}

func deletedRejection(slug string, at time.Time) Rejection {
	return Rejection{Slug: slug, Reason: ReasonDeleted,
		Message: fmt.Sprintf("app %s was deleted on %s; restore it from Apps", slug, at.UTC().Format("Jan 2, 2006"))}
}

func limitRejection(slug, project string, l *apps.LimitError) Rejection {
	if l.Limit == apps.LimitMaxNewPerHour {
		return Rejection{Slug: slug, Reason: ReasonRateLimit, Message: fmt.Sprintf(
			"app %q was not created: %d new apps were already created in project %s in the last hour (ingest.max_new_apps_per_hour); "+
				"check that the SDK's app name does not change per process or deploy, or try again later", slug, l.Max, project)}
	}
	return Rejection{Slug: slug, Reason: ReasonAppLimit, Message: fmt.Sprintf(
		"app %q was not created: project %s already has %d apps (ingest.max_apps_per_project); "+
			"merge or delete apps you do not need from Apps, or ask your administrator to raise the limit", slug, project, l.Max)}
}

func (r *AppResolver) negative(key string) (Rejection, bool) {
	r.negMu.Lock()
	defer r.negMu.Unlock()
	e, ok := r.neg[key]
	if !ok {
		return Rejection{}, false
	}
	if r.now().After(e.until) {
		delete(r.neg, key)
		return Rejection{}, false
	}
	return e.r, true
}

func (r *AppResolver) remember(key string, rej Rejection) {
	r.negMu.Lock()
	defer r.negMu.Unlock()
	if len(r.neg) > 10_000 {
		r.neg = map[string]negEntry{}
	}
	r.neg[key] = negEntry{r: rej, until: r.now().Add(r.negTTL)}
}

// Forget drops a project from the cache (after a dashboard change in this
// process).
func (r *AppResolver) Forget(projectID uuid.UUID) {
	r.mu.Lock()
	delete(r.cache, projectID)
	r.mu.Unlock()
	r.negMu.Lock()
	prefix := projectID.String() + "/"
	for k := range r.neg {
		if strings.HasPrefix(k, prefix) {
			delete(r.neg, k)
		}
	}
	r.negMu.Unlock()
}

func distinct(in []string) []string {
	seen := make(map[string]bool, len(in))
	out := make([]string, 0, len(in))
	for _, s := range in {
		s = strings.TrimSpace(s)
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

func (r *AppResolver) get(ctx context.Context, projectID uuid.UUID, force bool) (*projectApps, error) {
	if !force {
		r.mu.RLock()
		pa, ok := r.cache[projectID]
		r.mu.RUnlock()
		if ok && time.Since(pa.loadedAt) < r.ttl {
			return pa, nil
		}
	}
	v, err, _ := r.group.Do(projectID.String(), func() (any, error) {
		since := r.now().Add(-apps.DeletedReservation)
		rows, err := r.store.ListResolverApps(ctx, db.ListResolverAppsParams{ProjectID: projectID, DeletedSince: &since})
		if err != nil {
			return nil, fmt.Errorf("catalog: list apps: %w", err)
		}
		aliases, err := r.store.ListProjectAppAliases(ctx, projectID)
		if err != nil {
			return nil, fmt.Errorf("catalog: list app aliases: %w", err)
		}
		pa := &projectApps{
			byID: make(map[uuid.UUID]appEntry, len(rows)), bySlug: make(map[string]appEntry, len(rows)),
			aliases: make(map[string]uuid.UUID, len(aliases)), deleted: map[string]time.Time{}, loadedAt: time.Now(),
		}
		for _, row := range rows {
			if row.DeletedAt != nil {
				continue
			}
			e := appEntry{id: row.ID, slug: row.Slug, archived: row.ArchivedAt != nil, mergedInto: row.MergedInto}
			pa.byID[row.ID] = e
			pa.bySlug[row.Slug] = e
			if row.IsDefault {
				pa.defaultID = row.ID
			}
		}
		for _, row := range rows {
			if row.DeletedAt == nil {
				continue
			}
			if _, active := pa.bySlug[row.Slug]; active {
				continue
			}
			if at, ok := pa.deleted[row.Slug]; !ok || row.DeletedAt.After(at) {
				pa.deleted[row.Slug] = *row.DeletedAt
			}
		}
		for _, a := range aliases {
			pa.aliases[a.AliasSlug] = a.AppID
		}
		r.mu.Lock()
		r.cache[projectID] = pa
		r.mu.Unlock()
		return pa, nil
	})
	if err != nil {
		return nil, err
	}
	return v.(*projectApps), nil
}
