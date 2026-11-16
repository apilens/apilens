package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/apps"
	"github.com/apilens/apilens/internal/identity"
	"github.com/apilens/apilens/internal/ingest"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/server"
)

// Paths of the app management endpoints.
const (
	AppsPath           = ProjectPath + "/apps"
	AppPath            = AppsPath + "/{id}"
	AppArchivePath     = AppPath + "/archive"
	AppRestorePath     = AppPath + "/restore"
	AppAcknowledgePath = AppPath + "/acknowledge"
	AppMergePath       = AppPath + "/merge"
	AppRejectionsPath  = ProjectPath + "/app-rejections"
)

// AppService manages a project's apps; *apps.Service satisfies it.
type AppService interface {
	List(ctx context.Context, projectID uuid.UUID) ([]apps.App, error)
	Rename(ctx context.Context, actor, projectID, id uuid.UUID, name string) error
	Archive(ctx context.Context, actor, projectID, id uuid.UUID) error
	Restore(ctx context.Context, actor, projectID, id uuid.UUID) error
	Delete(ctx context.Context, actor, projectID, id uuid.UUID) error
	Acknowledge(ctx context.Context, actor, projectID, id uuid.UUID) error
	Merge(ctx context.Context, actor, projectID, source, target uuid.UUID) error
}

// AppRejectionReader reads the records ingest rejected because of their
// app; *ingest.ValkeyStats satisfies it.
type AppRejectionReader interface {
	AppRejections(ctx context.Context, projectID uuid.UUID, days []time.Time) ([]ingest.AppRejection, error)
}

// ManagedApp is an app as the Apps page lists it.
type ManagedApp struct {
	ID               string     `json:"id" format:"uuid"`
	Slug             string     `json:"slug" doc:"What SDKs send as the app name (normalised); it never changes."`
	Name             string     `json:"name" doc:"Display name."`
	State            string     `json:"state" enum:"active,archived,merged,deleted" doc:"active; archived (hidden, data naming it brings it back); merged (archived, its data goes to merged_into); deleted (its slug stays reserved until restorable_until)."`
	CreatedBy        string     `json:"created_by" enum:"sdk,dashboard" doc:"sdk: ingest created it from the app name an SDK sent; dashboard: created in the dashboard (the default app of a project)."`
	CreatedByKeyID   *string    `json:"created_by_key_id" required:"true" nullable:"true" format:"uuid" doc:"The API key whose data created the app; null for dashboard apps."`
	CreatedByKeyName *string    `json:"created_by_key_name" required:"true" nullable:"true" doc:"That key's name."`
	CreatedAt        time.Time  `json:"created_at"`
	FirstSeenAt      *time.Time `json:"first_seen_at" required:"true" nullable:"true" doc:"When ingest first received data for the app; null if never."`
	LastSeenAt       *time.Time `json:"last_seen_at" required:"true" nullable:"true" doc:"When a key last sent data for the app (recorded at most once a minute); null if never."`
	ArchivedAt       *time.Time `json:"archived_at" required:"true" nullable:"true"`
	DeletedAt        *time.Time `json:"deleted_at" required:"true" nullable:"true"`
	RestorableUntil  *time.Time `json:"restorable_until" required:"true" nullable:"true" doc:"For a deleted app: until when it can be restored and its slug stays reserved."`
	AcknowledgedAt   *time.Time `json:"acknowledged_at" required:"true" nullable:"true" doc:"When someone kept the app from the \"New app detected\" notice (or created it)."`
	New              bool       `json:"new" doc:"Created by the SDK in the last 7 days and not acknowledged."`
	IsDefault        bool       `json:"is_default" doc:"The default app receives records that name no app; it cannot be archived, merged or deleted."`
	MergedInto       *string    `json:"merged_into" required:"true" nullable:"true" format:"uuid" doc:"For a merged app: the app its data goes to."`
	MergedIntoSlug   *string    `json:"merged_into_slug" required:"true" nullable:"true"`
}

// ListAppsOutput is the response of GET /api/v1/projects/{slug}/apps.
type ListAppsOutput struct {
	Body struct {
		Apps []ManagedApp `json:"apps" doc:"Active apps first (by slug), then archived and merged ones, then apps deleted in the last 30 days."`
	}
}

// AppInput names an app of a project in the path.
type AppInput struct {
	ProjectSlugInput
	ID string `path:"id" format:"uuid" doc:"The app's id."`
}

// RenameAppInput is the request of PATCH /api/v1/projects/{slug}/apps/{id}.
type RenameAppInput struct {
	AppInput
	Body struct {
		Name string `json:"name" minLength:"1" maxLength:"100" doc:"The new display name. The slug SDKs send does not change."`
	}
}

// MergeAppInput is the request of POST /api/v1/projects/{slug}/apps/{id}/merge.
type MergeAppInput struct {
	AppInput
	Body struct {
		Into string `json:"into" format:"uuid" doc:"The active app to merge this app into."`
	}
}

// AppRejectionsInput is the request of GET /api/v1/projects/{slug}/app-rejections.
type AppRejectionsInput struct {
	ProjectSlugInput
	Days int `query:"days" minimum:"1" maximum:"30" default:"7" doc:"How many UTC days, today included."`
}

// AppRejectionCount is the records naming one app refused for one reason.
type AppRejectionCount struct {
	App     string `json:"app" doc:"The normalised app name the records carried (empty when it was unusable)."`
	Reason  string `json:"reason" enum:"app_create_forbidden,app_not_allowed,app_deleted,app_limit,app_rate_limit,invalid_app_name,unknown_app" doc:"app_create_forbidden: the key cannot create apps; app_not_allowed: the key is limited to other apps; app_deleted: the app was deleted less than 30 days ago; app_limit: ingest.max_apps_per_project reached; app_rate_limit: ingest.max_new_apps_per_hour reached; invalid_app_name; unknown_app: an app id that matches no app."`
	Records int64  `json:"records"`
	LastDay string `json:"last_day" format:"date" doc:"The last UTC day with such rejections."`
}

// AppRejectionsOutput is the response of GET /api/v1/projects/{slug}/app-rejections.
type AppRejectionsOutput struct {
	Body struct {
		Days       int                 `json:"days"`
		Rejections []AppRejectionCount `json:"rejections" doc:"Most records first; empty when nothing was rejected (or the counters are unavailable: see available)."`
		Available  bool                `json:"available" doc:"false when the counters are not kept (no Valkey) or could not be read."`
	}
}

// Apps serves the app management endpoints.
type Apps struct {
	svc        AppService
	rejections AppRejectionReader
	authz      ProjectAuthorizer
	logger     *slog.Logger
	now        func() time.Time
}

// NewApps returns the app endpoints over svc. rejections may be nil.
func NewApps(svc AppService, rejections AppRejectionReader, guard ProjectAuthorizer, logger *slog.Logger) *Apps {
	return &Apps{svc: svc, rejections: rejections, authz: guard, logger: logger, now: time.Now}
}

// Register mounts the app operations.
func (a *Apps) Register(api huma.API) {
	security := []map[string][]string{{authn.SchemeSession: {}}}
	tags := []string{server.TagProjects}
	read := "Needs `view` on the project (any member, including viewers). "
	write := "Needs `manage_capture` on the project (project admins, organization owners and admins; 403 `forbidden` for other members). "
	hidden := "A project the caller cannot view, or an app it does not have, answers 404 `not_found`."
	codes := []identity.ErrCode{identity.CodeInvalidRequest, identity.CodeUnauthenticated, identity.CodeForbidden, identity.CodeNotFound, identity.CodeAuthzUnavailable, identity.CodeInternal}

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "list-apps", Method: http.MethodGet, Path: AppsPath, Summary: "List a project's apps",
		Description: "Lists the project's apps with where each came from (the SDK, from which key, or the dashboard), when data last arrived, and whether it is archived, merged or deleted. " +
			"Apps come from the SDK: ingest creates an app the first time an SDK sends its app name. " + read + hidden,
		Tags: tags, Security: security,
	}, identity.CodeUnauthenticated, identity.CodeNotFound, identity.CodeAuthzUnavailable, identity.CodeInternal), a.list)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "rename-app", Method: http.MethodPatch, Path: AppPath, DefaultStatus: http.StatusNoContent, Summary: "Rename an app",
		Description: "Changes the app's display name. The slug SDKs send never changes. Audited as `app.renamed`. " + write + hidden,
		Tags:        tags, Security: security,
	}, codes...), a.rename)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "archive-app", Method: http.MethodPost, Path: AppArchivePath, DefaultStatus: http.StatusNoContent, Summary: "Archive an app",
		Description: "Hides the app. Data naming it later un-archives it (audited as `app.restored` with `by` sdk). The default app cannot be archived (`invalid_request`). " +
			"Audited as `app.archived`. " + write + hidden,
		Tags: tags, Security: security,
	}, codes...), a.archive)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "restore-app", Method: http.MethodPost, Path: AppRestorePath, DefaultStatus: http.StatusNoContent, Summary: "Restore an app",
		Description: "Brings back an archived, merged or deleted app. A merged app's slug stops routing to the app it was merged into. " +
			"Restoring a deleted app whose slug a newer app took answers `slug_taken` (409). Audited as `app.restored`. " + write + hidden,
		Tags: tags, Security: security,
	}, append(codes, identity.CodeSlugTaken)...), a.restore)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "acknowledge-app", Method: http.MethodPost, Path: AppAcknowledgePath, DefaultStatus: http.StatusNoContent, Summary: "Keep a new app",
		Description: "Acknowledges an app the SDK created, so it no longer shows as \"New app detected\". Audited as `app.acknowledged`. " + write + hidden,
		Tags:        tags, Security: security,
	}, codes...), a.acknowledge)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "merge-app", Method: http.MethodPost, Path: AppMergePath, DefaultStatus: http.StatusNoContent, Summary: "Merge an app into another",
		Description: "Merges the app into `into` (for typos and forks): the app is archived, its slug becomes an alias of `into` and data naming it lands in `into` from now on. " +
			"Data already stored is not rewritten and stays under the old app. `into` must be active and differ from the app; the default app cannot be merged. Audited as `app.merged`. " + write + hidden,
		Tags: tags, Security: security,
	}, codes...), a.merge)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "delete-app", Method: http.MethodDelete, Path: AppPath, DefaultStatus: http.StatusNoContent, Summary: "Delete an app",
		Description: "Deletes the app. For 30 days its slug stays reserved: data naming it is rejected with `app_deleted`, and the app can be restored. After that a new app may take the slug. " +
			"The default app cannot be deleted. Audited as `app.deleted`. " + write + hidden,
		Tags: tags, Security: security,
	}, codes...), a.delete)

	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "list-app-rejections", Method: http.MethodGet, Path: AppRejectionsPath, Summary: "Records rejected because of their app",
		Description: "Counts, per app name and reason, the records ingest refused over the last `days` UTC days because of the app they named: the key cannot create apps or is limited to other apps, " +
			"the app limits (`ingest.max_apps_per_project`, `ingest.max_new_apps_per_hour`) were reached, or the app was deleted. The rest of each batch was stored. " + read + hidden,
		Tags: tags, Security: security,
	}, identity.CodeUnauthenticated, identity.CodeNotFound, identity.CodeAuthzUnavailable, identity.CodeInternal), a.listRejections)
}

// authorize checks permission on the project slug and returns its id and
// the signed-in user.
func (a *Apps) authorize(ctx context.Context, slug string, permission authz.Permission) (uuid.UUID, uuid.UUID, error) {
	p, ok := authn.FromContext(ctx)
	if !ok || p.Kind != authn.KindUser {
		return uuid.Nil, uuid.Nil, identity.Err(identity.CodeUnauthenticated)
	}
	if a.authz == nil {
		return uuid.Nil, uuid.Nil, identity.ErrRetryAfter(identity.CodeAuthzUnavailable, time.Second)
	}
	t, err := a.authz.AuthorizeProject(ctx, p, slug, permission)
	switch {
	case err == nil:
		return t.ProjectID, p.UserID, nil
	case errors.Is(err, authz.ErrNoResource):
		return uuid.Nil, uuid.Nil, identity.Err(identity.CodeNotFound)
	case errors.Is(err, authz.ErrForbidden):
		return uuid.Nil, uuid.Nil, identity.Err(identity.CodeForbidden)
	case errors.Is(err, authz.ErrUnavailable):
		return uuid.Nil, uuid.Nil, identity.ErrRetryAfter(identity.CodeAuthzUnavailable, time.Second)
	default:
		a.logger.ErrorContext(ctx, "authorize apps", "error", err)
		return uuid.Nil, uuid.Nil, identity.Err(identity.CodeInternal)
	}
}

func (a *Apps) problem(ctx context.Context, op string, err error) error {
	detail := func(code identity.ErrCode, msg string) error {
		pr := identity.Err(code)
		pr.Detail = msg
		return pr
	}
	switch {
	case errors.Is(err, apps.ErrNotFound):
		return identity.Err(identity.CodeNotFound)
	case errors.Is(err, apps.ErrDefaultApp):
		return detail(identity.CodeInvalidRequest, "The default app receives records that name no app; it cannot be archived, merged or deleted.")
	case errors.Is(err, apps.ErrNotArchived):
		return detail(identity.CodeInvalidRequest, "The app is active; only archived, merged or deleted apps can be restored.")
	case errors.Is(err, apps.ErrSlugTaken):
		return detail(identity.CodeSlugTaken, "A newer app uses this app's slug; rename or delete it first.")
	case errors.Is(err, apps.ErrInvalid):
		return detail(identity.CodeInvalidRequest, "Pick an active app other than this one.")
	default:
		a.logger.ErrorContext(ctx, op, "error", err)
		return identity.Err(identity.CodeInternal)
	}
}

func toManagedApp(m apps.App) ManagedApp {
	var keyID, merged *string
	if m.CreatedByKeyID != nil {
		s := m.CreatedByKeyID.String()
		keyID = &s
	}
	if m.MergedInto != nil {
		s := m.MergedInto.String()
		merged = &s
	}
	return ManagedApp{
		ID: m.ID.String(), Slug: m.Slug, Name: m.Name, State: m.State, CreatedBy: m.CreatedBy,
		CreatedByKeyID: keyID, CreatedByKeyName: m.CreatedByKeyName, CreatedAt: m.CreatedAt.UTC(),
		FirstSeenAt: utc(m.FirstSeenAt), LastSeenAt: utc(m.LastSeenAt), ArchivedAt: utc(m.ArchivedAt),
		DeletedAt: utc(m.DeletedAt), RestorableUntil: utc(m.RestorableUntil), AcknowledgedAt: utc(m.AcknowledgedAt),
		New: m.New, IsDefault: m.IsDefault, MergedInto: merged, MergedIntoSlug: m.MergedIntoSlug,
	}
}

func (a *Apps) list(ctx context.Context, in *ProjectSlugInput) (*ListAppsOutput, error) {
	pid, _, err := a.authorize(ctx, in.Slug, authz.ProjectView)
	if err != nil {
		return nil, err
	}
	list, err := a.svc.List(ctx, pid)
	if err != nil {
		return nil, a.problem(ctx, "list apps", err)
	}
	out := &ListAppsOutput{}
	out.Body.Apps = make([]ManagedApp, 0, len(list))
	for _, m := range list {
		out.Body.Apps = append(out.Body.Apps, toManagedApp(m))
	}
	return out, nil
}

// change authorizes a write on the app of in and runs fn.
func (a *Apps) change(ctx context.Context, in AppInput, op string, fn func(actor, project, app uuid.UUID) error) (*struct{}, error) {
	pid, uid, err := a.authorize(ctx, in.Slug, authz.ProjectManageCapture)
	if err != nil {
		return nil, err
	}
	id, err := uuid.Parse(in.ID)
	if err != nil {
		return nil, identity.Err(identity.CodeNotFound)
	}
	if err := fn(uid, pid, id); err != nil {
		return nil, a.problem(ctx, op, err)
	}
	return nil, nil
}

func (a *Apps) rename(ctx context.Context, in *RenameAppInput) (*struct{}, error) {
	return a.change(ctx, in.AppInput, "rename app", func(actor, project, app uuid.UUID) error {
		return a.svc.Rename(ctx, actor, project, app, in.Body.Name)
	})
}

func (a *Apps) archive(ctx context.Context, in *AppInput) (*struct{}, error) {
	return a.change(ctx, *in, "archive app", func(actor, project, app uuid.UUID) error {
		return a.svc.Archive(ctx, actor, project, app)
	})
}

func (a *Apps) restore(ctx context.Context, in *AppInput) (*struct{}, error) {
	return a.change(ctx, *in, "restore app", func(actor, project, app uuid.UUID) error {
		return a.svc.Restore(ctx, actor, project, app)
	})
}

func (a *Apps) acknowledge(ctx context.Context, in *AppInput) (*struct{}, error) {
	return a.change(ctx, *in, "acknowledge app", func(actor, project, app uuid.UUID) error {
		return a.svc.Acknowledge(ctx, actor, project, app)
	})
}

func (a *Apps) delete(ctx context.Context, in *AppInput) (*struct{}, error) {
	return a.change(ctx, *in, "delete app", func(actor, project, app uuid.UUID) error {
		return a.svc.Delete(ctx, actor, project, app)
	})
}

func (a *Apps) merge(ctx context.Context, in *MergeAppInput) (*struct{}, error) {
	into, err := uuid.Parse(in.Body.Into)
	if err != nil {
		return nil, identity.Err(identity.CodeInvalidRequest)
	}
	return a.change(ctx, in.AppInput, "merge app", func(actor, project, app uuid.UUID) error {
		return a.svc.Merge(ctx, actor, project, app, into)
	})
}

func (a *Apps) listRejections(ctx context.Context, in *AppRejectionsInput) (*AppRejectionsOutput, error) {
	pid, _, err := a.authorize(ctx, in.Slug, authz.ProjectView)
	if err != nil {
		return nil, err
	}
	days := in.Days
	if days <= 0 {
		days = 7
	}
	out := &AppRejectionsOutput{}
	out.Body.Days = days
	out.Body.Rejections = []AppRejectionCount{}
	if a.rejections == nil {
		return out, nil
	}
	today := a.now().UTC()
	list := make([]time.Time, days)
	for i := range days {
		list[i] = today.AddDate(0, 0, -i)
	}
	rows, err := a.rejections.AppRejections(ctx, pid, list)
	if err != nil {
		a.logger.WarnContext(ctx, "app rejections unavailable", "error", err)
		return out, nil
	}
	out.Body.Available = true
	for _, r := range rows {
		out.Body.Rejections = append(out.Body.Rejections, AppRejectionCount{
			App: r.App, Reason: r.Reason, Records: r.Records, LastDay: r.LastDay.Format(time.DateOnly),
		})
	}
	return out, nil
}
