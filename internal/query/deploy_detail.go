package query

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"slices"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
)

// The caps of one deploy comparison: rows a reader can still take in.
const (
	maxDeployEndpoints  = 500
	maxDeployStatuses   = 50
	maxDeployExceptions = 50
	maxDeployConsumers  = 20
)

// What counts as one step of regression when ordering endpoints: the same
// thresholds the UI uses to call a change worse (lib/changes.ts).
const (
	errorRateStepPP = 0.5
	p95StepRatio    = 0.1
	p95StepMs       = 5
)

// registerDeployDetail mounts GET /api/v1/deploys/{id} and
// GET /api/v1/deploys/{id}/comparison: one deploy, the traffic around it and
// what changed with it.
func registerDeployDetail(api huma.API, s *Service) {
	huma.Register(api, huma.Operation{
		OperationID: "get-deploy",
		Method:      http.MethodGet,
		Path:        "/api/v1/deploys/{id}",
		Summary:     "One deploy: before/after error rate and p95, traffic per minute around it, previous and next deploy",
		Description: "The deploy the id names (from list-deploy-changes), with requests, error rate and p95 of its app (or the project " +
			"for a project-wide deploy) in its environment in the hour before and the hour after its minute, requests, 4xx, 5xx and " +
			"p95 per minute across both windows, and the previous and next deploy of the same app and environment. An unknown id, " +
			"or another project's, answers 404." + readAccess,
		Tags:     []string{"Dashboard"},
		Security: security,
	}, s.deployDetail)
	huma.Register(api, huma.Operation{
		OperationID: "get-deploy-comparison",
		Method:      http.MethodGet,
		Path:        "/api/v1/deploys/{id}/comparison",
		Summary:     "What changed with a deploy: per-endpoint before/after, error status codes, exceptions and consumers with errors",
		Description: "Over the same hour before and hour after as get-deploy: per endpoint requests, 4xx, 5xx, error rate and p95 on each " +
			"side (biggest regression first, then endpoints seen only after, then endpoints seen only before), error status codes " +
			"and server exceptions with their count on each side (new ones have none before), and the consumers that got errors " +
			"after the deploy. An unknown id, or another project's, answers 404." + readAccess,
		Tags:     []string{"Dashboard"},
		Security: security,
	}, s.deployComparison)
}

// DeployIDInput names one deploy of the caller's project.
type DeployIDInput struct {
	ProjectInput
	ID string `path:"id" pattern:"^[0-9a-f]{1,16}$" maxLength:"16" example:"9f3a1b2c4d5e6f70" doc:"Deploy id, as list-deploy-changes returns it."`
}

type deployRef struct {
	ID         string    `json:"id" doc:"The deploy's id."`
	Release    string    `json:"release" doc:"Release name or version that was deployed."`
	DeployedAt time.Time `json:"deployed_at" doc:"When the deploy happened, as reported."`
}

type deployPoint struct {
	TS           time.Time `json:"ts" doc:"Start of the minute."`
	Requests     uint64    `json:"requests" doc:"Requests in the minute."`
	ClientErrors uint64    `json:"client_errors" doc:"Requests answered 4xx."`
	ServerErrors uint64    `json:"server_errors" doc:"Requests answered 5xx."`
	P95Ms        float64   `json:"p95_ms" doc:"p95 latency of the minute; 0 without requests."`
}

type deployDetail struct {
	deployChange
	ReceivedAt time.Time `json:"received_at" doc:"When APILens received the deploy report."`
}

type deployDetailOutput struct {
	Body struct {
		Deploy        deployDetail  `json:"deploy" doc:"The deploy, with its before and after traffic."`
		WindowMinutes int           `json:"window_minutes" doc:"Length of the before and after windows, in minutes."`
		BeforeFrom    time.Time     `json:"before_from" doc:"Start of the before window (inclusive); it ends at the deploy's minute."`
		DeployMinute  time.Time     `json:"deploy_minute" doc:"The deploy's own minute: mixed traffic, in neither window."`
		AfterFrom     time.Time     `json:"after_from" doc:"Start of the after window (inclusive), the minute after the deploy's."`
		AfterTo       time.Time     `json:"after_to" doc:"End of the after window (exclusive); before window_minutes have passed, the end of the current minute."`
		AfterMinutes  int           `json:"after_minutes" doc:"Minutes the after window covers so far; window_minutes once it is complete."`
		Previous      *deployRef    `json:"previous,omitempty" doc:"The deploy before this one of the same app and environment; absent when none."`
		Next          *deployRef    `json:"next,omitempty" doc:"The deploy after this one of the same app and environment; absent when none."`
		Series        []deployPoint `json:"series" doc:"Every minute from before_from to after_to, oldest first and zero-filled, the deploy's minute included."`
	}
}

type splitSide struct {
	sideStats
	ClientErrors uint64 `json:"client_errors" doc:"Requests answered 4xx."`
	ServerErrors uint64 `json:"server_errors" doc:"Requests answered 5xx."`
}

type deployEndpoint struct {
	Method string    `json:"method" doc:"HTTP method."`
	Path   string    `json:"path" doc:"Route template."`
	Change string    `json:"change" enum:"compared,new,gone" doc:"compared: traffic on both sides; new: requests only after the deploy; gone: requests only before."`
	Before splitSide `json:"before" doc:"The hour before the deploy's minute."`
	After  splitSide `json:"after" doc:"The after window."`
}

type deployStatus struct {
	StatusCode uint16 `json:"status_code" doc:"HTTP status code, 400 or above."`
	Before     uint64 `json:"before" doc:"Requests answered with it before the deploy."`
	After      uint64 `json:"after" doc:"Requests answered with it after the deploy."`
	New        bool   `json:"new" doc:"Seen after the deploy but not in the hour before."`
}

type deployException struct {
	ExceptionType string `json:"exception_type" doc:"Exception class; empty when the SDK reported none."`
	Message       string `json:"message" doc:"Exception message."`
	Before        uint64 `json:"before" doc:"Times raised before the deploy."`
	After         uint64 `json:"after" doc:"Times raised after the deploy."`
	New           bool   `json:"new" doc:"Raised after the deploy but not in the hour before."`
	Method        string `json:"method" doc:"HTTP method of the endpoint that last raised it; empty when not reported."`
	Path          string `json:"path" doc:"Route of the endpoint that last raised it; empty when not reported."`
}

type deployConsumer struct {
	ConsumerID     string `json:"consumer_id" doc:"Consumer id."`
	ConsumerName   string `json:"consumer_name" doc:"Latest consumer name; empty when not reported."`
	BeforeRequests uint64 `json:"before_requests" doc:"Requests before the deploy."`
	BeforeErrors   uint64 `json:"before_errors" doc:"Requests answered 4xx or 5xx before the deploy."`
	AfterRequests  uint64 `json:"after_requests" doc:"Requests after the deploy."`
	AfterErrors    uint64 `json:"after_errors" doc:"Requests answered 4xx or 5xx after the deploy."`
}

type deployComparisonOutput struct {
	Body struct {
		Endpoints         []deployEndpoint  `json:"endpoints" doc:"Endpoints with traffic on either side: compared ones by biggest regression first, then new, then gone (at most 500)."`
		Statuses          []deployStatus    `json:"statuses" doc:"Error status codes on either side, most frequent after the deploy first (at most 50)."`
		Exceptions        []deployException `json:"exceptions" doc:"Server exceptions on either side, most frequent after the deploy first (at most 50)."`
		Consumers         []deployConsumer  `json:"consumers" doc:"Consumers that got errors after the deploy, most errors first (at most 20)."`
		ConsumersAffected int               `json:"consumers_affected" doc:"Every consumer that got errors after the deploy, beyond the 20 listed."`
	}
}

// deployAround is one deploy and the windows of traffic compared around it.
type deployAround struct {
	d                           deployDetail
	from, minute, afterFrom, to time.Time
	partial                     bool
	where                       string // tenant, environment and app of the deploy
	args                        []any
	appID                       uuid.UUID
}

var errDeployNotFound = errors.New("deploy not found")

// findDeploy reads the deploy id names in project and the windows around it.
func (s *Service) findDeploy(ctx context.Context, project uuid.UUID, id string) (deployAround, error) {
	rows, err := s.ch.Query(ctx, `
		SELECT `+deployIDExpr+` AS id, deployed_at, release, commit, environment, url, app_id, received_at
		FROM api_deploys WHERE project_id = ? AND id = ?
		ORDER BY received_at LIMIT 1`, project, id)
	if err != nil {
		return deployAround{}, internalError("deploy", err)
	}
	defer func() { _ = rows.Close() }()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return deployAround{}, internalError("deploy", err)
		}
		return deployAround{}, errDeployNotFound
	}
	var a deployAround
	if err := rows.Scan(&a.d.ID, &a.d.DeployedAt, &a.d.Release, &a.d.Commit, &a.d.Environment, &a.d.URL, &a.appID, &a.d.ReceivedAt); err != nil {
		return deployAround{}, internalError("deploy", err)
	}
	if a.appID != uuid.Nil {
		a.d.AppID = a.appID.String()
	}
	a.from, a.minute, a.afterFrom, a.to, a.partial = impactSides(a.d.DeployedAt, s.now())
	a.d.AfterPartial = a.partial
	a.where, a.args = tenantFilter(project, a.d.Environment)
	if a.appID != uuid.Nil {
		a.where += " AND app_id = ?"
		a.args = append(a.args, a.appID)
	}
	return a, nil
}

// deployFor resolves the caller's project and the deploy, as a 404 when it is
// not one of the project's.
func (s *Service) deployFor(ctx context.Context, in *DeployIDInput) (deployAround, error) {
	p, err := principalFrom(ctx)
	if err != nil {
		return deployAround{}, err
	}
	a, err := s.findDeploy(ctx, p.ProjectID, in.ID)
	if errors.Is(err, errDeployNotFound) {
		return deployAround{}, huma.Error404NotFound("deploy not found")
	}
	return a, err
}

func (s *Service) deployDetail(ctx context.Context, in *DeployIDInput) (*deployDetailOutput, error) {
	qctx, cancel := queryCtx(ctx)
	defer cancel()
	a, err := s.deployFor(qctx, in)
	if err != nil {
		return nil, err
	}
	p, _ := principalFrom(ctx)
	out := &deployDetailOutput{}
	b := &out.Body
	b.WindowMinutes = int(impactWindow.Minutes())
	b.BeforeFrom, b.DeployMinute, b.AfterFrom, b.AfterTo = a.from, a.minute, a.afterFrom, a.to
	b.AfterMinutes = max(0, int(a.to.Sub(a.afterFrom)/time.Minute))
	if err := s.fillImpact(qctx, p.ProjectID, &a.d.deployChange, s.now()); err != nil {
		return nil, err
	}
	b.Deploy = a.d
	if b.Previous, err = s.adjacentDeploy(qctx, p.ProjectID, a, false); err != nil {
		return nil, err
	}
	if b.Next, err = s.adjacentDeploy(qctx, p.ProjectID, a, true); err != nil {
		return nil, err
	}
	if b.Series, err = s.deploySeries(qctx, a); err != nil {
		return nil, err
	}
	return out, nil
}

// adjacentDeploy is the deploy right before (or after) a's of the same app
// and environment, nil when there is none.
func (s *Service) adjacentDeploy(ctx context.Context, project uuid.UUID, a deployAround, after bool) (*deployRef, error) {
	cmp, order := "<", "DESC"
	if after {
		cmp, order = ">", "ASC"
	}
	rows, err := s.ch.Query(ctx, `
		SELECT `+deployIDExpr+`, release, deployed_at FROM api_deploys
		WHERE project_id = ? AND app_id = ? AND environment = ? AND deployed_at `+cmp+` ?
		ORDER BY deployed_at `+order+`, release LIMIT 1`, project, a.appID, a.d.Environment, a.d.DeployedAt)
	if err != nil {
		return nil, internalError("adjacent deploy", err)
	}
	defer func() { _ = rows.Close() }()
	if !rows.Next() {
		return nil, rows.Err()
	}
	var r deployRef
	if err := rows.Scan(&r.ID, &r.Release, &r.DeployedAt); err != nil {
		return nil, internalError("adjacent deploy", err)
	}
	return &r, nil
}

// deploySeries is every minute of [from, to) around the deploy, zero-filled.
func (s *Service) deploySeries(ctx context.Context, a deployAround) ([]deployPoint, error) {
	rows, err := s.ch.Query(ctx, `
		SELECT bucket, sum(requests), sum(client_errors), sum(server_errors), `+quantiles+`
		FROM api_requests_1m WHERE `+a.where+` AND bucket >= ? AND bucket < ?
		GROUP BY bucket ORDER BY bucket`, append(slices.Clone(a.args), a.from, a.to)...)
	if err != nil {
		return nil, internalError("deploy series", err)
	}
	defer func() { _ = rows.Close() }()
	got := map[int64]deployPoint{}
	for rows.Next() {
		var (
			pt deployPoint
			q  []float32
		)
		if err := rows.Scan(&pt.TS, &pt.Requests, &pt.ClientErrors, &pt.ServerErrors, &q); err != nil {
			return nil, internalError("deploy series", err)
		}
		if pt.Requests > 0 {
			pt.P95Ms = quantile(q, 3)
		}
		got[pt.TS.Unix()] = pt
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("deploy series", err)
	}
	return fillMinutes(a.from, a.to, got), nil
}

// fillMinutes lists every minute of [from, to), taking the ones got has.
func fillMinutes(from, to time.Time, got map[int64]deployPoint) []deployPoint {
	out := []deployPoint{}
	for t := from; t.Before(to); t = t.Add(time.Minute) {
		pt := got[t.Unix()]
		pt.TS = t.UTC()
		out = append(out, pt)
	}
	return out
}

func (s *Service) deployComparison(ctx context.Context, in *DeployIDInput) (*deployComparisonOutput, error) {
	qctx, cancel := queryCtx(ctx)
	defer cancel()
	a, err := s.deployFor(qctx, in)
	if err != nil {
		return nil, err
	}
	out := &deployComparisonOutput{}
	b := &out.Body
	if b.Endpoints, err = s.deployEndpoints(qctx, a); err != nil {
		return nil, err
	}
	if b.Statuses, err = s.deployStatuses(qctx, a); err != nil {
		return nil, err
	}
	if b.Exceptions, err = s.deployExceptions(qctx, a); err != nil {
		return nil, err
	}
	if b.Consumers, b.ConsumersAffected, err = s.deployConsumers(qctx, a); err != nil {
		return nil, err
	}
	return out, nil
}

func (s *Service) deployEndpoints(ctx context.Context, a deployAround) ([]deployEndpoint, error) {
	before, after := "bucket < ?", "bucket >= ?"
	args := []any{a.minute, a.minute, a.minute, a.minute, a.afterFrom, a.afterFrom, a.afterFrom, a.afterFrom}
	args = append(append(args, a.args...), a.from, a.to, a.minute, maxDeployEndpoints)
	rows, err := s.ch.Query(ctx, fmt.Sprintf(`
		SELECT method, path,
			sumIf(requests, %[1]s), sumIf(client_errors, %[1]s), sumIf(server_errors, %[1]s), %[3]s,
			sumIf(requests, %[2]s), sumIf(client_errors, %[2]s), sumIf(server_errors, %[2]s), %[4]s
		FROM api_requests_1m WHERE %[5]s AND bucket >= ? AND bucket < ? AND bucket != ?
		GROUP BY method, path ORDER BY sum(requests) DESC, path, method LIMIT ?`,
		before, after, fmt.Sprintf(quantilesIf, before), fmt.Sprintf(quantilesIf, after), a.where), args...)
	if err != nil {
		return nil, internalError("deploy endpoints", err)
	}
	defer func() { _ = rows.Close() }()
	out := []deployEndpoint{}
	for rows.Next() {
		var (
			e                deployEndpoint
			bReq, bCli, bSrv uint64
			aReq, aCli, aSrv uint64
			qBefore, qAfter  []float32
		)
		if err := rows.Scan(&e.Method, &e.Path, &bReq, &bCli, &bSrv, &qBefore, &aReq, &aCli, &aSrv, &qAfter); err != nil {
			return nil, internalError("deploy endpoints", err)
		}
		e.Before = splitSide{sideOf(bReq, bCli+bSrv, qBefore), bCli, bSrv}
		e.After = splitSide{sideOf(aReq, aCli+aSrv, qAfter), aCli, aSrv}
		switch {
		case bReq == 0 && aReq == 0:
			continue
		case bReq == 0:
			e.Change = "new"
		case aReq == 0:
			e.Change = "gone"
		default:
			e.Change = "compared"
		}
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("deploy endpoints", err)
	}
	sortDeployEndpoints(out)
	return out, nil
}

// regression is how many steps worse an endpoint got across a deploy: the
// larger of its error-rate move (in 0.5 pp steps) and its p95 move (in 10%
// steps, only when it moved at least 5 ms). When neither got worse, the
// larger improvement, as a negative number.
func regression(b, a sideStats) float64 {
	if b.Requests == 0 || a.Requests == 0 {
		return 0
	}
	errSteps := (a.ErrorRate - b.ErrorRate) * 100 / errorRateStepPP
	latSteps := 0.0
	if d := a.P95Ms - b.P95Ms; b.P95Ms > 0 && math.Abs(d) >= p95StepMs {
		latSteps = d / b.P95Ms / p95StepRatio
	}
	if worst := max(errSteps, latSteps); worst > 0 {
		return worst
	}
	return min(errSteps, latSteps)
}

var changeOrder = map[string]int{"compared": 0, "new": 1, "gone": 2}

// sortDeployEndpoints orders compared endpoints by regression (worst first),
// then new ones by requests after, then gone ones by requests before.
func sortDeployEndpoints(es []deployEndpoint) {
	slices.SortStableFunc(es, func(x, y deployEndpoint) int {
		if c := changeOrder[x.Change] - changeOrder[y.Change]; c != 0 {
			return c
		}
		var kx, ky float64
		switch x.Change {
		case "compared":
			kx, ky = regression(x.Before.sideStats, x.After.sideStats), regression(y.Before.sideStats, y.After.sideStats)
		case "new":
			kx, ky = float64(x.After.Requests), float64(y.After.Requests)
		default:
			kx, ky = float64(x.Before.Requests), float64(y.Before.Requests)
		}
		switch {
		case kx > ky:
			return -1
		case kx < ky:
			return 1
		}
		if x.Path != y.Path {
			if x.Path < y.Path {
				return -1
			}
			return 1
		}
		if x.Method < y.Method {
			return -1
		}
		if x.Method > y.Method {
			return 1
		}
		return 0
	})
}

// sidesFilter is the raw-table predicate of both windows, leaving the
// deploy's minute out, and its arguments.
func (a deployAround) sidesFilter() (string, []any) {
	return a.where + " AND timestamp >= ? AND timestamp < ? AND (timestamp < ? OR timestamp >= ?)",
		append(slices.Clone(a.args), a.from, a.to, a.minute, a.afterFrom)
}

func (s *Service) deployStatuses(ctx context.Context, a deployAround) ([]deployStatus, error) {
	where, wargs := a.sidesFilter()
	rows, err := s.ch.Query(ctx, `
		SELECT status_code, countIf(timestamp < ?) AS b, countIf(timestamp >= ?) AS a
		FROM api_requests WHERE `+where+` AND status_code >= 400
		GROUP BY status_code ORDER BY a DESC, b DESC, status_code LIMIT ?`,
		append(append([]any{a.minute, a.afterFrom}, wargs...), maxDeployStatuses)...)
	if err != nil {
		return nil, internalError("deploy statuses", err)
	}
	defer func() { _ = rows.Close() }()
	out := []deployStatus{}
	for rows.Next() {
		var st deployStatus
		if err := rows.Scan(&st.StatusCode, &st.Before, &st.After); err != nil {
			return nil, internalError("deploy statuses", err)
		}
		st.New = st.Before == 0 && st.After > 0
		out = append(out, st)
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("deploy statuses", err)
	}
	return out, nil
}

func (s *Service) deployExceptions(ctx context.Context, a deployAround) ([]deployException, error) {
	where, wargs := a.sidesFilter()
	rows, err := s.ch.Query(ctx, `
		SELECT message, countIf(timestamp < ?) AS b, countIf(timestamp >= ?) AS a,
		       argMax(endpoint_method, timestamp), argMax(endpoint_path, timestamp)
		FROM api_logs WHERE `+where+` AND level IN ('ERROR', 'CRITICAL') AND logger_name = ?
		GROUP BY message ORDER BY a DESC, b DESC, message LIMIT ?`,
		append(append([]any{a.minute, a.afterFrom}, wargs...), exceptionLogger, maxDeployExceptions)...)
	if err != nil {
		return nil, internalError("deploy exceptions", err)
	}
	defer func() { _ = rows.Close() }()
	out := []deployException{}
	for rows.Next() {
		var (
			e   deployException
			msg string
		)
		if err := rows.Scan(&msg, &e.Before, &e.After, &e.Method, &e.Path); err != nil {
			return nil, internalError("deploy exceptions", err)
		}
		e.ExceptionType, e.Message = splitException(msg)
		e.New = e.Before == 0 && e.After > 0
		out = append(out, e)
	}
	if err := rows.Err(); err != nil {
		return nil, internalError("deploy exceptions", err)
	}
	return out, nil
}

func (s *Service) deployConsumers(ctx context.Context, a deployAround) ([]deployConsumer, int, error) {
	where, wargs := a.sidesFilter()
	inner := `
		SELECT consumer_id, argMax(consumer_name, timestamp) AS name,
		       countIf(timestamp < ?) AS b, countIf(timestamp < ? AND status_code >= 400) AS be,
		       countIf(timestamp >= ?) AS a, countIf(timestamp >= ? AND status_code >= 400) AS ae
		FROM api_requests WHERE ` + where + ` AND consumer_id != ''
		GROUP BY consumer_id HAVING ae > 0`
	args := append([]any{a.minute, a.minute, a.afterFrom, a.afterFrom}, wargs...)
	var total uint64
	if err := s.ch.QueryRow(ctx, `SELECT count() FROM (`+inner+`)`, args...).Scan(&total); err != nil {
		return nil, 0, internalError("deploy consumers", err)
	}
	rows, err := s.ch.Query(ctx, inner+` ORDER BY ae DESC, consumer_id LIMIT ?`, append(args, maxDeployConsumers)...)
	if err != nil {
		return nil, 0, internalError("deploy consumers", err)
	}
	defer func() { _ = rows.Close() }()
	out := []deployConsumer{}
	for rows.Next() {
		var c deployConsumer
		if err := rows.Scan(&c.ConsumerID, &c.ConsumerName, &c.BeforeRequests, &c.BeforeErrors, &c.AfterRequests, &c.AfterErrors); err != nil {
			return nil, 0, internalError("deploy consumers", err)
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, internalError("deploy consumers", err)
	}
	return out, int(total), nil
}
