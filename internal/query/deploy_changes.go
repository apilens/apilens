package query

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
)

// impactWindow is how much traffic on each side of a deploy the Changes view
// compares.
const impactWindow = time.Hour

// The -If variant of the shared quantile merge, so one scan yields both sides.
const quantilesIf = "quantilesTDigestMergeIf(0.5, 0.75, 0.9, 0.95, 0.99)(latency, %s)"

// registerDeployChanges mounts GET /api/v1/deploys/changes: the most recent
// deploys, each with its error rate and p95 in the hour before and after.
func registerDeployChanges(api huma.API, s *Service) {
	huma.Register(api, huma.Operation{
		OperationID: "list-deploy-changes",
		Method:      http.MethodGet,
		Path:        "/api/v1/deploys/changes",
		Summary:     "Deploys with error rate and p95 one hour before and after each",
		Tags:        []string{"Dashboard"},
		Security:    security,
	}, s.deployChanges)
}

// DeployChangesInput is RangeInput plus a cap on the deploys compared (each
// costs one rollup read).
type DeployChangesInput struct {
	RangeInput
	Limit int `query:"limit" minimum:"1" maximum:"50" default:"25" doc:"Most recent deploys to compare."`
}

type sideStats struct {
	Requests  uint64  `json:"requests"`
	ErrorRate float64 `json:"error_rate" doc:"(client_errors + server_errors) / requests; 0 without requests."`
	P95Ms     float64 `json:"p95_ms" doc:"0 without requests."`
}

type deployChange struct {
	DeployedAt   time.Time `json:"deployed_at"`
	Release      string    `json:"release"`
	Commit       string    `json:"commit"`
	Environment  string    `json:"environment"`
	URL          string    `json:"url"`
	AppID        string    `json:"app_id" doc:"The deployed app; empty for a project-wide deploy."`
	Before       sideStats `json:"before" doc:"The hour before the deploy's minute."`
	After        sideStats `json:"after" doc:"The hour after the deploy's minute; the minute itself is in neither side."`
	AfterPartial bool      `json:"after_partial" doc:"The after window is still open and covers less than an hour so far."`
}

type deployChangesOutput struct {
	Body struct {
		WindowMinutes int            `json:"window_minutes"`
		Deploys       []deployChange `json:"deploys"`
	}
}

// impactSides splits the traffic around a deploy at t: before is
// [from, minute), after is [afterFrom, to), where minute is the deploy's own
// minute (mixed traffic, left out). to is clipped to the end of now's minute,
// and partial reports that clip.
func impactSides(t, now time.Time) (from, minute, afterFrom, to time.Time, partial bool) {
	minute = t.UTC().Truncate(time.Minute)
	from = minute.Add(-impactWindow)
	afterFrom = minute.Add(time.Minute)
	to = afterFrom.Add(impactWindow)
	if limit := now.UTC().Truncate(time.Minute).Add(time.Minute); to.After(limit) {
		to, partial = limit, true
	}
	return from, minute, afterFrom, to, partial
}

func (s *Service) deployChanges(ctx context.Context, in *DeployChangesInput) (*deployChangesOutput, error) {
	p, err := principalFrom(ctx)
	if err != nil {
		return nil, err
	}
	w, err := resolveWindow(in.Range, s.now())
	if err != nil {
		return nil, err
	}
	limit := in.Limit
	if limit <= 0 || limit > 50 {
		limit = 25
	}
	where, args := tenantFilter(p.ProjectID, in.Env)
	qctx, cancel := queryCtx(ctx)
	defer cancel()
	rows, err := s.ch.Query(qctx, `
		SELECT deployed_at, release, commit, environment, url, app_id
		FROM api_deploys WHERE `+where+` AND deployed_at >= ? AND deployed_at < ?
		ORDER BY deployed_at DESC LIMIT ?`, append(args, w.from, w.to, limit)...)
	if err != nil {
		return nil, internalError("deploy changes", err)
	}
	list := []deployChange{}
	for rows.Next() {
		var (
			d   deployChange
			app uuid.UUID
		)
		if err := rows.Scan(&d.DeployedAt, &d.Release, &d.Commit, &d.Environment, &d.URL, &app); err != nil {
			_ = rows.Close()
			return nil, internalError("deploy changes", err)
		}
		if app != uuid.Nil {
			d.AppID = app.String()
		}
		list = append(list, d)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return nil, internalError("deploy changes", err)
	}

	now := s.now()
	for i := range list {
		if err := s.fillImpact(qctx, p.ProjectID, &list[i], now); err != nil {
			return nil, err
		}
	}
	out := &deployChangesOutput{}
	out.Body.WindowMinutes = int(impactWindow.Minutes())
	out.Body.Deploys = list
	return out, nil
}

// fillImpact reads the per-minute rollup around one deploy, in the deploy's
// environment and, unless it is project-wide, its app.
func (s *Service) fillImpact(ctx context.Context, project uuid.UUID, d *deployChange, now time.Time) error {
	from, minute, afterFrom, to, partial := impactSides(d.DeployedAt, now)
	d.AfterPartial = partial
	where, args := tenantFilter(project, d.Environment)
	if d.AppID != "" {
		where += " AND app_id = ?"
		args = append(args, uuid.MustParse(d.AppID))
	}
	var (
		before, beforeErrs, after, afterErrs uint64
		qBefore, qAfter                      []float32
	)
	err := s.ch.QueryRow(ctx, fmt.Sprintf(`
		SELECT
			sumIf(requests, bucket < ?), sumIf(client_errors + server_errors, bucket < ?), %s,
			sumIf(requests, bucket >= ?), sumIf(client_errors + server_errors, bucket >= ?), %s
		FROM api_requests_1m WHERE %s AND bucket >= ? AND bucket < ? AND bucket != ?`,
		fmt.Sprintf(quantilesIf, "bucket < ?"), fmt.Sprintf(quantilesIf, "bucket >= ?"), where),
		append([]any{minute, minute, minute, afterFrom, afterFrom, afterFrom}, append(args, from, to, minute)...)...,
	).Scan(&before, &beforeErrs, &qBefore, &after, &afterErrs, &qAfter)
	if err != nil {
		return internalError("deploy impact", err)
	}
	d.Before = sideOf(before, beforeErrs, qBefore)
	d.After = sideOf(after, afterErrs, qAfter)
	return nil
}

func sideOf(requests, errs uint64, q []float32) sideStats {
	s := sideStats{Requests: requests}
	if requests > 0 {
		s.ErrorRate = float64(errs) / float64(requests)
		s.P95Ms = quantile(q, 3)
	}
	return s
}
