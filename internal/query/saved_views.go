package query

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/identity"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/server"
)

// Saved views: named filter sets of a dashboard surface, kept per project.
// A shared view is listed for everyone who can view the project (members
// and the project's read key); a private one only for its creator. The
// creator edits and deletes a view; so do project admins (manage_capture:
// project admins, organization owners and admins) for the shared ones.

// SavedViewsPath is the collection of a project's saved views. The project
// is {project}, its slug, as authz.Guard reads it.
const SavedViewsPath = server.APIPrefix + "/projects/{" + authz.ParamProject + "}/views"

// SavedViewPath is one saved view of a project.
const SavedViewPath = SavedViewsPath + "/{id}"

// Limits of a saved view.
const (
	maxViewNameLen     = 128
	maxViewFilterBytes = 16384
)

// SavedViewStore is the control-plane subset the saved view operations use;
// *db.Queries satisfies it. The Service's Catalog must implement it too, or
// the operations answer 503.
type SavedViewStore interface {
	ListSavedViews(ctx context.Context, arg db.ListSavedViewsParams) ([]db.SavedView, error)
	GetSavedView(ctx context.Context, arg db.GetSavedViewParams) (db.SavedView, error)
	CreateSavedView(ctx context.Context, arg db.CreateSavedViewParams) (db.SavedView, error)
	UpdateSavedView(ctx context.Context, arg db.UpdateSavedViewParams) (db.SavedView, error)
	DeleteSavedView(ctx context.Context, arg db.DeleteSavedViewParams) (int64, error)
}

// SavedView is a named filter set of one dashboard surface.
type SavedView struct {
	ID        string         `json:"id" format:"uuid" doc:"The view's id."`
	Name      string         `json:"name" doc:"Display name."`
	Surface   string         `json:"surface" enum:"explore,endpoints,errors,performance,consumers,apps" doc:"The dashboard surface the view belongs to."`
	Filter    map[string]any `json:"filter" doc:"The surface's filter state, as saved. The server stores it as is."`
	Shared    bool           `json:"shared" doc:"Whether everyone who can view the project sees the view; false means only its creator does."`
	CreatedBy *string        `json:"created_by" required:"true" nullable:"true" format:"uuid" doc:"The user who created the view; null once that user is gone."`
	CreatedAt time.Time      `json:"created_at" doc:"When the view was created."`
	UpdatedAt time.Time      `json:"updated_at" doc:"When the view was last changed."`
}

type savedViewOutput struct {
	Body SavedView
}

type savedViewsOutput struct {
	Body struct {
		Views []SavedView `json:"views" doc:"Shared views and the caller's own private views, by surface then name."`
	}
}

type listSavedViewsInput struct {
	Project string `path:"project" maxLength:"63" doc:"Project slug."`
	Surface string `query:"surface" enum:"explore,endpoints,errors,performance,consumers,apps" doc:"Only the views of this surface; omitted means every surface."`
}

type savedViewInput struct {
	Project string `path:"project" maxLength:"63" doc:"Project slug."`
	ID      string `path:"id" format:"uuid" doc:"The view's id."`
}

type createSavedViewInput struct {
	Project string `path:"project" maxLength:"63" doc:"Project slug."`
	Body    struct {
		Name    string         `json:"name" minLength:"1" maxLength:"128" doc:"Display name, 1 to 128 characters; surrounding spaces are dropped. Unique among the caller's views of the surface."`
		Surface string         `json:"surface" enum:"explore,endpoints,errors,performance,consumers,apps" doc:"The dashboard surface the view belongs to."`
		Filter  map[string]any `json:"filter,omitempty" doc:"The surface's filter state, a JSON object of at most 16 KiB; omitted means no filter."`
		Shared  bool           `json:"shared,omitempty" doc:"Show the view to everyone who can view the project; omitted means private."`
	}
}

type updateSavedViewInput struct {
	Project string `path:"project" maxLength:"63" doc:"Project slug."`
	ID      string `path:"id" format:"uuid" doc:"The view's id."`
	Body    struct {
		Name   string         `json:"name" minLength:"1" maxLength:"128" doc:"Display name, 1 to 128 characters; surrounding spaces are dropped."`
		Filter map[string]any `json:"filter,omitempty" doc:"The surface's filter state, a JSON object of at most 16 KiB; omitted means no filter."`
		Shared bool           `json:"shared,omitempty" doc:"Show the view to everyone who can view the project; omitted means private."`
	}
}

func registerSavedViews(api huma.API, s *Service, guard *authz.Guard) {
	view := huma.Middlewares{guard.RequireProject(api, authz.ProjectView)}
	session := []map[string][]string{{authn.SchemeSession: {}}}
	readers := []map[string][]string{{authn.SchemeSession: {}}, {SchemeReadKey: {}}}
	guarded := []identity.ErrCode{identity.CodeUnauthenticated, identity.CodeNotFound, identity.CodeAuthzUnavailable}
	edit := "Needs a user session: the view's creator, or for a shared view a project admin (project admins, organization owners and admins); 403 for other members. " +
		"A view the caller cannot see (another user's private view, or one of another project) answers 404."

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "list-saved-views",
		Method:      http.MethodGet,
		Path:        SavedViewsPath,
		Summary:     "List the saved views of a project",
		Description: "The project's shared views and the caller's own private views, by surface then name. " +
			"Open to a session that can view the project or to the project's read key, which sees the shared views only.",
		Tags:        []string{server.TagProjects},
		Security:    readers,
		Middlewares: view,
	}, guarded...), s.listSavedViews)
	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "get-saved-view",
		Method:      http.MethodGet,
		Path:        SavedViewPath,
		Summary:     "Get a saved view",
		Description: "One view of the project: a shared one, or one of the caller's own private views (404 otherwise). " +
			"Open to a session that can view the project or to the project's read key.",
		Tags:        []string{server.TagProjects},
		Security:    readers,
		Middlewares: view,
	}, guarded...), s.getSavedView)
	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID:   "create-saved-view",
		Method:        http.MethodPost,
		Path:          SavedViewsPath,
		Summary:       "Save a view",
		Description:   "Saves a named filter set of a surface, owned by the caller. Needs a user session that can view the project. A name the caller already uses on the surface answers 409.",
		Tags:          []string{server.TagProjects},
		Security:      session,
		Middlewares:   view,
		DefaultStatus: http.StatusCreated,
	}, guarded...), s.createSavedView)
	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "update-saved-view",
		Method:      http.MethodPut,
		Path:        SavedViewPath,
		Summary:     "Replace a saved view",
		Description: "Replaces the name, filter and sharing of a view; its surface and creator stay. " + edit + " A name the creator already uses on the surface answers 409.",
		Tags:        []string{server.TagProjects},
		Security:    session,
		Middlewares: view,
	}, guarded...), func(ctx context.Context, in *updateSavedViewInput) (*savedViewOutput, error) {
		return s.updateSavedView(ctx, guard, in)
	})
	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID:   "delete-saved-view",
		Method:        http.MethodDelete,
		Path:          SavedViewPath,
		Summary:       "Delete a saved view",
		Description:   "Deletes a view. " + edit,
		Tags:          []string{server.TagProjects},
		Security:      session,
		Middlewares:   view,
		DefaultStatus: http.StatusNoContent,
	}, guarded...), func(ctx context.Context, in *savedViewInput) (*struct{}, error) {
		return s.deleteSavedView(ctx, guard, in)
	})
}

func (s *Service) viewStore() (SavedViewStore, error) {
	store, ok := s.catalog.(SavedViewStore)
	if !ok {
		return nil, huma.Error503ServiceUnavailable("saved views unavailable")
	}
	return store, nil
}

// viewCaller is the project the guard authorized and the caller's user id
// (nil for a read key).
func viewCaller(ctx context.Context) (authz.Target, *uuid.UUID, error) {
	t, ok := authz.TargetFromContext(ctx)
	if !ok {
		return authz.Target{}, nil, identity.Err(identity.CodeUnauthenticated)
	}
	p, ok := authn.FromContext(ctx)
	if !ok || p.Kind != authn.KindUser {
		return t, nil, nil
	}
	uid := p.UserID
	return t, &uid, nil
}

// viewUser is viewCaller for the operations that need a user session.
func viewUser(ctx context.Context) (authz.Target, authn.Principal, error) {
	t, ok := authz.TargetFromContext(ctx)
	p, pok := authn.FromContext(ctx)
	if !ok || !pok || p.Kind != authn.KindUser {
		return authz.Target{}, authn.Principal{}, huma.Error401Unauthorized("a user session is required")
	}
	return t, p, nil
}

func (s *Service) listSavedViews(ctx context.Context, in *listSavedViewsInput) (*savedViewsOutput, error) {
	t, viewer, err := viewCaller(ctx)
	if err != nil {
		return nil, err
	}
	store, err := s.viewStore()
	if err != nil {
		return nil, err
	}
	rows, err := store.ListSavedViews(ctx, db.ListSavedViewsParams{ProjectID: t.ProjectID, Viewer: viewer, Surface: in.Surface})
	if err != nil {
		return nil, internalError("list saved views", err)
	}
	out := &savedViewsOutput{}
	out.Body.Views = make([]SavedView, 0, len(rows))
	for _, r := range rows {
		v, err := toSavedView(r)
		if err != nil {
			return nil, err
		}
		out.Body.Views = append(out.Body.Views, v)
	}
	return out, nil
}

func (s *Service) getSavedView(ctx context.Context, in *savedViewInput) (*savedViewOutput, error) {
	t, viewer, err := viewCaller(ctx)
	if err != nil {
		return nil, err
	}
	store, err := s.viewStore()
	if err != nil {
		return nil, err
	}
	row, err := visibleView(ctx, store, t.ProjectID, in.ID, viewer)
	if err != nil {
		return nil, err
	}
	v, err := toSavedView(row)
	if err != nil {
		return nil, err
	}
	return &savedViewOutput{Body: v}, nil
}

func (s *Service) createSavedView(ctx context.Context, in *createSavedViewInput) (*savedViewOutput, error) {
	t, p, err := viewUser(ctx)
	if err != nil {
		return nil, err
	}
	store, err := s.viewStore()
	if err != nil {
		return nil, err
	}
	name, filter, err := normalizeView(in.Body.Name, in.Body.Filter)
	if err != nil {
		return nil, err
	}
	id, err := uuid.NewV7()
	if err != nil {
		return nil, internalError("view id", err)
	}
	uid := p.UserID
	row, err := store.CreateSavedView(ctx, db.CreateSavedViewParams{
		ID: id, ProjectID: t.ProjectID, Name: name, Surface: in.Body.Surface, Filter: filter, Shared: in.Body.Shared, CreatedBy: &uid,
	})
	if isUniqueViolation(err) {
		return nil, huma.Error409Conflict("you already have a view with this name on this surface")
	}
	if err != nil {
		return nil, internalError("save view", err)
	}
	v, err := toSavedView(row)
	if err != nil {
		return nil, err
	}
	return &savedViewOutput{Body: v}, nil
}

func (s *Service) updateSavedView(ctx context.Context, projects ProjectAuthorizer, in *updateSavedViewInput) (*savedViewOutput, error) {
	t, p, err := viewUser(ctx)
	if err != nil {
		return nil, err
	}
	store, err := s.viewStore()
	if err != nil {
		return nil, err
	}
	name, filter, err := normalizeView(in.Body.Name, in.Body.Filter)
	if err != nil {
		return nil, err
	}
	cur, err := editableView(ctx, store, projects, p, t, in.Project, in.ID)
	if err != nil {
		return nil, err
	}
	row, err := store.UpdateSavedView(ctx, db.UpdateSavedViewParams{
		ID: cur.ID, ProjectID: t.ProjectID, Name: name, Filter: filter, Shared: in.Body.Shared,
	})
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		return nil, huma.Error404NotFound("view not found")
	case isUniqueViolation(err):
		return nil, huma.Error409Conflict("the view's creator already has a view with this name on this surface")
	case err != nil:
		return nil, internalError("save view", err)
	}
	v, err := toSavedView(row)
	if err != nil {
		return nil, err
	}
	return &savedViewOutput{Body: v}, nil
}

func (s *Service) deleteSavedView(ctx context.Context, projects ProjectAuthorizer, in *savedViewInput) (*struct{}, error) {
	t, p, err := viewUser(ctx)
	if err != nil {
		return nil, err
	}
	store, err := s.viewStore()
	if err != nil {
		return nil, err
	}
	cur, err := editableView(ctx, store, projects, p, t, in.Project, in.ID)
	if err != nil {
		return nil, err
	}
	n, err := store.DeleteSavedView(ctx, db.DeleteSavedViewParams{ID: cur.ID, ProjectID: t.ProjectID})
	if err != nil {
		return nil, internalError("delete view", err)
	}
	if n == 0 {
		return nil, huma.Error404NotFound("view not found")
	}
	return nil, nil
}

// visibleView loads a view of project that viewer may see: a shared one,
// or one of viewer's own. Anything else answers 404.
func visibleView(ctx context.Context, store SavedViewStore, project uuid.UUID, rawID string, viewer *uuid.UUID) (db.SavedView, error) {
	id, err := uuid.Parse(rawID)
	if err != nil {
		return db.SavedView{}, huma.Error404NotFound("view not found")
	}
	row, err := store.GetSavedView(ctx, db.GetSavedViewParams{ID: id, ProjectID: project})
	if errors.Is(err, pgx.ErrNoRows) {
		return db.SavedView{}, huma.Error404NotFound("view not found")
	}
	if err != nil {
		return db.SavedView{}, internalError("view lookup", err)
	}
	if !row.Shared && !ownsView(row, viewer) {
		return db.SavedView{}, huma.Error404NotFound("view not found")
	}
	return row, nil
}

// editableView loads a view p may change: one p created, or a shared one
// when p is a project admin (manage_capture on slug).
func editableView(ctx context.Context, store SavedViewStore, projects ProjectAuthorizer, p authn.Principal, t authz.Target, slug, rawID string) (db.SavedView, error) {
	uid := p.UserID
	row, err := visibleView(ctx, store, t.ProjectID, rawID, &uid)
	if err != nil || ownsView(row, &uid) {
		return row, err
	}
	if projects == nil {
		return db.SavedView{}, huma.Error503ServiceUnavailable("authorization backend unavailable, retry later")
	}
	at, err := projects.AuthorizeProject(ctx, p, slug, authz.ProjectManageCapture)
	switch {
	case err == nil && at.ProjectID == t.ProjectID:
		return row, nil
	case err == nil, errors.Is(err, authz.ErrNoResource):
		// The slug now names another project, or the caller lost view.
		return db.SavedView{}, huma.Error404NotFound("view not found")
	case errors.Is(err, authz.ErrForbidden):
		return db.SavedView{}, huma.Error403Forbidden("only the view's creator or a project admin can change it")
	case errors.Is(err, authz.ErrUnavailable):
		return db.SavedView{}, huma.Error503ServiceUnavailable("authorization backend unavailable, retry later")
	default:
		return db.SavedView{}, internalError("authorization", err)
	}
}

func ownsView(r db.SavedView, user *uuid.UUID) bool {
	return user != nil && r.CreatedBy != nil && *r.CreatedBy == *user
}

// normalizeView trims and checks a view's name and encodes its filter.
func normalizeView(name string, filter map[string]any) (string, []byte, error) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > maxViewNameLen {
		return "", nil, huma.Error422UnprocessableEntity("name must be 1 to 128 characters")
	}
	if filter == nil {
		filter = map[string]any{}
	}
	b, err := json.Marshal(filter)
	if err != nil {
		return "", nil, huma.Error422UnprocessableEntity("filter must be a JSON object")
	}
	if len(b) > maxViewFilterBytes {
		return "", nil, huma.Error422UnprocessableEntity("filter must be at most 16 KiB")
	}
	return name, b, nil
}

func toSavedView(r db.SavedView) (SavedView, error) {
	v := SavedView{
		ID: r.ID.String(), Name: r.Name, Surface: r.Surface, Shared: r.Shared,
		CreatedAt: r.CreatedAt.UTC(), UpdatedAt: r.UpdatedAt.UTC(), Filter: map[string]any{},
	}
	if len(r.Filter) > 0 {
		if err := json.Unmarshal(r.Filter, &v.Filter); err != nil {
			return SavedView{}, internalError("view filter", err)
		}
	}
	if r.CreatedBy != nil {
		u := r.CreatedBy.String()
		v.CreatedBy = &u
	}
	return v, nil
}

// uniqueViolation is Postgres' SQLSTATE for a unique constraint violation.
const uniqueViolation = "23505"

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == uniqueViolation
}
