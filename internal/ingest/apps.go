package ingest

import (
	"context"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/valkey-io/valkey-go"

	"github.com/apilens/apilens/internal/controlplane/apikeys"
	"github.com/apilens/apilens/internal/controlplane/catalog"
	"github.com/apilens/apilens/internal/controlplane/store/db"
)

// Apps come from the SDK: the app name in each record decides the app.
// Unknown names create the app (when the key may), records naming no app go
// to the project's default app, and the records of an app that cannot be
// used (the key may not create it or is limited to other apps, a limit, a
// recently deleted app) are rejected while the rest of the batch is stored.
// So are the records of an environment a key pinned to some environments
// may not send for (environment_not_allowed).

// ReasonEnvironmentNotAllowed rejects the records of an environment the
// API key is not pinned to.
const ReasonEnvironmentNotAllowed = "environment_not_allowed"

// rejectedApp reports the records of one app identifier a call refused.
type rejectedApp struct {
	AppID       string `json:"app_id" doc:"The app identifier the records carried."`
	App         string `json:"app,omitempty" doc:"The normalised app slug."`
	Environment string `json:"environment,omitempty" doc:"The environment the records carried, for environment_not_allowed."`
	Records     int    `json:"records" doc:"How many records of the call named it."`
	Error       string `json:"error" doc:"Why: app_create_forbidden, app_not_allowed, app_deleted, app_limit, app_rate_limit, invalid_app_name, unknown_app or environment_not_allowed."`
	Detail      string `json:"detail" doc:"What happened and what to do, naming the app or environment."`
}

// appBatch is the outcome of resolving the app of every record of a call.
type appBatch struct {
	apps     map[string]uuid.UUID
	rejected map[string]catalog.Rejection
	// envRejected are the indexes of the records whose environment the key
	// may not send for.
	envRejected map[int]bool
	report      []rejectedApp
	dropped     int
}

// keep reports whether record i, naming ident, is stored.
func (b *appBatch) keep(i int, ident string) bool {
	if b.envRejected[i] {
		return false
	}
	_, rejected := b.rejected[strings.TrimSpace(ident)]
	return !rejected
}

// id returns the app of ident (uuid.Nil for a project-wide deploy).
func (b *appBatch) id(ident string) uuid.UUID { return b.apps[strings.TrimSpace(ident)] }

// filterRecords drops the records whose app or environment was rejected.
// recs must be in the order resolveBatch saw them.
func filterRecords[T any](recs []T, ident func(T) string, b *appBatch) []T {
	if len(b.rejected) == 0 && len(b.envRejected) == 0 {
		return recs
	}
	out := recs[:0:0]
	for i, r := range recs {
		if b.keep(i, ident(r)) {
			out = append(out, r)
		}
	}
	return out
}

// recordEnvs returns the normalised environment of every record.
func recordEnvs[T any](recs []T, env func(T) string) []string {
	out := make([]string, len(recs))
	for i, r := range recs {
		out[i] = environment(env(r))
	}
	return out
}

// rejectionStatus is the HTTP answer when every record of a call names an
// app that was rejected for reason.
func rejectionStatus(reason string) int {
	switch reason {
	case catalog.ReasonCreateForbidden, catalog.ReasonNotAllowed, ReasonEnvironmentNotAllowed:
		return http.StatusForbidden
	case catalog.ReasonDeleted:
		return http.StatusConflict
	default:
		return http.StatusUnprocessableEntity
	}
}

// caller is the catalog view of the key a call authenticated with.
func caller(p apikeys.Principal) catalog.Caller {
	return catalog.Caller{KeyID: p.KeyID, ProjectSlug: p.ProjectSlug, CanCreate: p.CanCreateApps(), AppIDs: p.AppIDs}
}

// resolveBatch resolves the app identifier of every record (idents has one
// entry per record), counts and reports rejected records, records which apps
// the key sent for, and answers an error when nothing is left to store.
// envs has the normalised environment of every record: records of an
// environment the key may not send for are rejected before their app is
// resolved. allowEmpty keeps records naming no app project-wide (deploys)
// instead of sending them to the default app.
func (e *Edge) resolveBatch(ctx context.Context, signal string, p apikeys.Principal, slugs, idents, envs []string, allowEmpty bool, t tally) (*appBatch, *apiError) {
	for _, s := range slugs {
		if s = strings.TrimSpace(s); s != "" && s != p.ProjectSlug {
			return nil, errValidation("project_slug must match the API key project '%s'", p.ProjectSlug)
		}
	}
	b := &appBatch{apps: map[string]uuid.UUID{}, rejected: map[string]catalog.Rejection{}}
	type envIdent struct{ ident, env string }
	envCounts := map[envIdent]int{}
	counts := map[string]int{}
	var lookup []string
	for i, id := range idents {
		id = strings.TrimSpace(id)
		if !p.AllowsEnvironment(envs[i]) {
			if b.envRejected == nil {
				b.envRejected = map[int]bool{}
			}
			b.envRejected[i] = true
			envCounts[envIdent{id, envs[i]}]++
			continue
		}
		if id == "" && allowEmpty {
			continue
		}
		if counts[id] == 0 {
			lookup = append(lookup, id)
		}
		counts[id]++
	}
	if len(lookup) > 0 {
		res, err := e.apps.ResolveFor(ctx, p.ProjectID, caller(p), lookup)
		if err != nil {
			e.logger.Error("app resolution unavailable", "error", err)
			return nil, errUnavailable("Catalog unavailable, retry later")
		}
		b.apps, b.rejected = res.Apps, res.Rejected
		if b.rejected == nil {
			b.rejected = map[string]catalog.Rejection{}
		}
		for _, id := range res.Created {
			e.appsCreated.Inc()
			e.logger.Info("app created from ingest", "project_id", p.ProjectID, "app_id", id, "key_id", p.KeyID)
		}
	}
	for k, n := range envCounts {
		b.dropped += n
		b.report = append(b.report, rejectedApp{
			AppID: k.ident, Environment: k.env, Records: n, Error: ReasonEnvironmentNotAllowed,
			Detail: fmt.Sprintf("The API key may not send data for environment '%s'; use a key for that environment or add it to the key's environments", k.env),
		})
		e.records.WithLabelValues(signal, "rejected").Add(float64(n))
		e.appRejected.WithLabelValues(ReasonEnvironmentNotAllowed).Add(float64(n))
	}
	day := map[appRejectionKey]int64{}
	for ident, rej := range b.rejected {
		n := counts[ident]
		b.dropped += n
		b.report = append(b.report, rejectedApp{AppID: ident, App: rej.Slug, Records: n, Error: rej.Reason, Detail: rej.Message})
		e.records.WithLabelValues(signal, "rejected").Add(float64(n))
		e.appRejected.WithLabelValues(rej.Reason).Add(float64(n))
		t.reject(rej.AppID, rej.Reason, int64(n))
		day[appRejectionKey{Reason: rej.Reason, App: rej.Slug}] += int64(n)
	}
	sort.Slice(b.report, func(i, j int) bool {
		if b.report[i].AppID != b.report[j].AppID {
			return b.report[i].AppID < b.report[j].AppID
		}
		return b.report[i].Environment < b.report[j].Environment
	})
	e.flushAppRejections(ctx, p.ProjectID, day)
	for _, id := range b.apps {
		e.sawKeyApp(p.KeyID, id)
	}
	e.sawEnvironments(p, b, idents, envs)
	if b.dropped > 0 && b.dropped == len(idents) {
		first := b.report[0]
		details := make([]string, len(b.report))
		for i, r := range b.report {
			details[i] = r.Detail
		}
		return b, &apiError{status: rejectionStatus(first.Error), Code: first.Error, Detail: strings.Join(details, "; ")}
	}
	return b, nil
}

// --------------------------------------------------------- environments

// EnvironmentRegistry registers the environments data names and keeps
// their last seen time; *catalog.EnvironmentRegistry satisfies it. Seen must
// not block on storage.
type EnvironmentRegistry interface {
	Seen(projectID, keyID uuid.UUID, names []string)
}

// WithEnvironments makes the edge register the environments of the records
// it stores (#788); nil registers nothing.
func (e *Edge) WithEnvironments(r EnvironmentRegistry) *Edge {
	e.envs = r
	return e
}

// sawEnvironments reports the distinct environments of the records of b
// that are stored.
func (e *Edge) sawEnvironments(p apikeys.Principal, b *appBatch, idents, envs []string) {
	if e.envs == nil {
		return
	}
	var names []string
	seen := map[string]bool{}
	for i, id := range idents {
		if !b.keep(i, id) || seen[envs[i]] {
			continue
		}
		seen[envs[i]] = true
		names = append(names, envs[i])
	}
	if len(names) > 0 {
		e.envs.Seen(p.ProjectID, p.KeyID, names)
	}
}

// ------------------------------------------------------------ key usage

// KeyAppStore records which apps each key sends for; *db.Queries satisfies
// it.
type KeyAppStore interface {
	UpsertAPIKeyApp(ctx context.Context, arg db.UpsertAPIKeyAppParams) error
	MarkAppFirstSeen(ctx context.Context, arg db.MarkAppFirstSeenParams) error
}

// keyAppInterval bounds how often one process writes the usage of a key and
// app pair.
const keyAppInterval = time.Minute

// WithKeyApps makes the edge record which apps each key sends for (at most
// once per key and app per minute); nil records nothing.
func (e *Edge) WithKeyApps(store KeyAppStore) *Edge {
	e.keyApps = store
	return e
}

type keyAppSeen struct {
	mu   sync.Mutex
	last map[[2]uuid.UUID]time.Time
}

// sawKeyApp writes the key's use of the app off the request path, throttled.
func (e *Edge) sawKeyApp(keyID, appID uuid.UUID) {
	if e.keyApps == nil || keyID == uuid.Nil || appID == uuid.Nil {
		return
	}
	now := e.now()
	k := [2]uuid.UUID{keyID, appID}
	e.keySeen.mu.Lock()
	if e.keySeen.last == nil || len(e.keySeen.last) > 100_000 {
		e.keySeen.last = map[[2]uuid.UUID]time.Time{}
	}
	if last, ok := e.keySeen.last[k]; ok && now.Sub(last) < keyAppInterval {
		e.keySeen.mu.Unlock()
		return
	}
	e.keySeen.last[k] = now
	e.keySeen.mu.Unlock()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		at := now.UTC()
		if err := e.keyApps.UpsertAPIKeyApp(ctx, db.UpsertAPIKeyAppParams{KeyID: keyID, AppID: appID, SeenAt: at}); err != nil {
			e.logger.Warn("failed to record api key app use", "key_id", keyID, "app_id", appID, "error", err)
			return
		}
		if err := e.keyApps.MarkAppFirstSeen(ctx, db.MarkAppFirstSeenParams{ID: appID, SeenAt: &at}); err != nil {
			e.logger.Warn("failed to record app first seen", "app_id", appID, "error", err)
		}
	}()
}

// ------------------------------------------------------- rejection stats

// AppRejectionKeyPrefix prefixes the per project and day hash of records
// rejected because of their app: AppRejectionKeyPrefix + "<project id>:<YYYY-MM-DD>",
// fields "<reason>|<app slug>".
const AppRejectionKeyPrefix = "apilens:ingest:app-rejections:"

type appRejectionKey struct{ Reason, App string }

// AppRejection is how many records naming one app were rejected for one
// reason over some days.
type AppRejection struct {
	Reason  string
	App     string
	Records int64
	LastDay time.Time
}

// AppRejectionStore keeps per project and day counts of records rejected
// because of their app; *ValkeyStats satisfies it.
type AppRejectionStore interface {
	AddAppRejections(ctx context.Context, projectID uuid.UUID, day time.Time, counts map[appRejectionKey]int64) error
}

// WithAppRejections makes the edge count rejected records per project, app
// name and reason for the Apps page; nil keeps Prometheus totals only.
func (e *Edge) WithAppRejections(store AppRejectionStore) *Edge {
	e.appRejections = store
	return e
}

func (e *Edge) flushAppRejections(ctx context.Context, projectID uuid.UUID, counts map[appRejectionKey]int64) {
	if e.appRejections == nil || len(counts) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), statsWriteTimeout)
	defer cancel()
	if err := e.appRejections.AddAppRejections(ctx, projectID, e.now(), counts); err != nil {
		e.logger.Warn("app rejection counters unavailable", "error", err)
	}
}

func appRejectionsKey(projectID uuid.UUID, day time.Time) string {
	return AppRejectionKeyPrefix + projectID.String() + ":" + day.UTC().Format(time.DateOnly)
}

// AddAppRejections implements AppRejectionStore.
func (v *ValkeyStats) AddAppRejections(ctx context.Context, projectID uuid.UUID, day time.Time, counts map[appRejectionKey]int64) error {
	key := appRejectionsKey(projectID, day)
	cmds := make(valkey.Commands, 0, len(counts)+1)
	for k, n := range counts {
		cmds = append(cmds, v.client.B().Hincrby().Key(key).Field(k.Reason+"|"+k.App).Increment(n).Build())
	}
	cmds = append(cmds, v.client.B().Expire().Key(key).Seconds(int64(statsTTL.Seconds())).Build())
	for _, res := range v.client.DoMulti(ctx, cmds...) {
		if err := res.Error(); err != nil {
			return fmt.Errorf("ingest app rejections: %w", err)
		}
	}
	return nil
}

// AppRejections sums the rejected records of the project over the UTC days
// of days, most records first.
func (v *ValkeyStats) AppRejections(ctx context.Context, projectID uuid.UUID, days []time.Time) ([]AppRejection, error) {
	cmds := make(valkey.Commands, len(days))
	for i, d := range days {
		cmds[i] = v.client.B().Hgetall().Key(appRejectionsKey(projectID, d)).Build()
	}
	sum := map[appRejectionKey]*AppRejection{}
	for i, res := range v.client.DoMulti(ctx, cmds...) {
		m, err := res.AsStrMap()
		if err != nil && !valkey.IsValkeyNil(err) {
			return nil, fmt.Errorf("ingest app rejections: %w", err)
		}
		for field, s := range m {
			reason, app, _ := strings.Cut(field, "|")
			n, err := strconv.ParseInt(s, 10, 64)
			if err != nil {
				continue
			}
			k := appRejectionKey{reason, app}
			a, ok := sum[k]
			if !ok {
				a = &AppRejection{Reason: reason, App: app}
				sum[k] = a
			}
			a.Records += n
			if d := days[i].UTC().Truncate(24 * time.Hour); d.After(a.LastDay) {
				a.LastDay = d
			}
		}
	}
	out := make([]AppRejection, 0, len(sum))
	for _, a := range sum {
		out = append(out, *a)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Records != out[j].Records {
			return out[i].Records > out[j].Records
		}
		return out[i].App < out[j].App
	})
	return out, nil
}
