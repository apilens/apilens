package query

import (
	"cmp"
	"context"
	"fmt"
	"net/http"
	"slices"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/identity"
	"github.com/apilens/apilens/internal/ingest"
	"github.com/apilens/apilens/internal/platform/authn"
	"github.com/apilens/apilens/internal/platform/server"
)

// ProjectUsagePath is the path of a project's ingest usage. The project is
// {project}, its slug, as authz.Guard reads it.
const ProjectUsagePath = server.APIPrefix + "/projects/{" + authz.ParamProject + "}/usage"

// ReasonUnspecified labels rejected records counted before the edge kept
// rejection reasons.
const ReasonUnspecified = "unspecified"

// UsageReader reads the per app and day counters with their breakdowns and
// the per project bytes; *ingest.ValkeyStats satisfies it. The ingest stats
// reader (WithIngestStats) must implement it, or project usage answers 503.
type UsageReader interface {
	AppUsage(ctx context.Context, appID uuid.UUID, days []time.Time) ([]ingest.AppUsage, error)
	ProjectBytes(ctx context.Context, projectID uuid.UUID, days []time.Time) ([]int64, error)
}

// RejectedRecords is the rejected records of one reason.
type RejectedRecords struct {
	Reason  string `json:"reason" doc:"Why the records were refused: records_per_minute or bytes_per_day (project quota), key_records_per_minute (the API key's rate limit), invalid (OTLP record dropped as invalid), an app refusal code (app_not_allowed, app_limit_reached, ...), or unspecified for records counted before reasons were kept."`
	Records int64  `json:"records" doc:"Rejected records."`
}

// UsageCounts are a project's ingest counters over a period.
type UsageCounts struct {
	IngestCounts
	RejectedByReason []RejectedRecords `json:"rejected_by_reason" doc:"rejected split by reason, most records first; sums to rejected."`
}

// UsageDay is the usage of one UTC day.
type UsageDay struct {
	Date string `json:"date" format:"date" doc:"UTC day, YYYY-MM-DD."`
	UsageCounts
	Bytes int64 `json:"bytes" doc:"Decompressed body bytes of the ingest calls admitted that day, as charged to the bytes_per_day quota."`
}

// AppUsageTotals is one app's usage over the period.
type AppUsageTotals struct {
	AppID string `json:"app_id" format:"uuid" doc:"The app's id."`
	App   string `json:"app" doc:"The app's slug."`
	UsageCounts
}

// EnvironmentUsage is the records accepted in one environment over the
// period.
type EnvironmentUsage struct {
	Environment string `json:"environment" doc:"Environment name the records carried."`
	Accepted    int64  `json:"accepted" doc:"Records stored in the environment."`
}

// QuotaUsage is the project's ingest limits and how close today is to them.
type QuotaUsage struct {
	IngestQuota
	BytesToday      int64    `json:"bytes_today" doc:"Bytes admitted today (UTC)."`
	BytesTodayRatio *float64 `json:"bytes_today_ratio" required:"true" nullable:"true" doc:"bytes_today over bytes_per_day; null when bytes are unlimited. The limit is a 24-hour rolling budget, so this is a close reading, not the exact refusal point."`
	RejectedToday   int64    `json:"rejected_today" doc:"Records refused today by a quota limit (records_per_minute or bytes_per_day)."`
}

// ProjectUsage is a project's ingest usage over the last days.
type ProjectUsage struct {
	Project      string             `json:"project" doc:"The project's slug."`
	Days         int                `json:"days" doc:"Number of UTC days covered, today included."`
	Totals       UsageCounts        `json:"totals" doc:"Sum over the days and the apps; equals the sum of each app's ingest-stats totals for the same days."`
	Bytes        int64              `json:"bytes" doc:"Bytes admitted over the days."`
	Daily        []UsageDay         `json:"daily" doc:"One entry per day, oldest first; a day without traffic is all zero."`
	Apps         []AppUsageTotals   `json:"apps" doc:"Totals per app of the project, most accepted records first."`
	Environments []EnvironmentUsage `json:"environments" doc:"Accepted records per environment, most first. Records counted before environments were kept are in totals only."`
	Quota        QuotaUsage         `json:"quota" doc:"The configured ingest limits and today's use of them."`
}

type projectUsageInput struct {
	Project string `path:"project" maxLength:"63" doc:"Project slug."`
	Days    int    `query:"days" minimum:"1" maximum:"30" default:"30" doc:"UTC days to cover, today included."`
}

type projectUsageOutput struct {
	Body ProjectUsage
}

// registerProjectUsage mounts GET /api/v1/projects/{project}/usage, open to
// a session with view on the project.
func registerProjectUsage(api huma.API, s *Service, guard *authz.Guard) {
	huma.Register(api, identity.Operation(api, huma.Operation{
		OperationID: "get-project-usage",
		Method:      http.MethodGet,
		Path:        ProjectUsagePath,
		Summary:     "Project ingest usage and quota: records and bytes per day, by app and environment",
		Description: "Sums the ingest edge's per-app counters (the ones get-app-ingest-stats reads) over the project's apps: " +
			"per UTC day the accepted, rejected (by reason), truncated and masked records and the bytes admitted; " +
			"totals per app and per environment; the configured quotas (ingest.quota.*) and today's use of them. " +
			"Records not tied to an app are not counted. Days are kept for 30 days. " +
			"503 when the install keeps no counters (no Valkey). Open to a session that can view the project.",
		Tags:        []string{server.TagProjects},
		Security:    []map[string][]string{{authn.SchemeSession: {}}},
		Middlewares: huma.Middlewares{guard.RequireProject(api, authz.ProjectView)},
	}, identity.CodeUnauthenticated, identity.CodeNotFound, identity.CodeAuthzUnavailable), s.projectUsage)
}

// usageSum accumulates counters and their reason split.
type usageSum struct {
	ingest.Counts
	reasons map[string]int64
}

func (u *usageSum) add(a ingest.AppUsage) {
	u.Counts = u.Counts.Add(a.Counts)
	var named int64
	for r, n := range a.RejectedBy {
		u.addReason(r, n)
		named += n
	}
	if rest := a.Rejected - named; rest > 0 {
		u.addReason(ReasonUnspecified, rest)
	}
}

func (u *usageSum) addReason(r string, n int64) {
	if u.reasons == nil {
		u.reasons = map[string]int64{}
	}
	u.reasons[r] += n
}

func (u *usageSum) counts() UsageCounts {
	out := UsageCounts{IngestCounts: ingestCounts(u.Counts), RejectedByReason: make([]RejectedRecords, 0, len(u.reasons))}
	for r, n := range u.reasons {
		out.RejectedByReason = append(out.RejectedByReason, RejectedRecords{Reason: r, Records: n})
	}
	slices.SortFunc(out.RejectedByReason, func(a, b RejectedRecords) int {
		return cmp.Or(cmp.Compare(b.Records, a.Records), cmp.Compare(a.Reason, b.Reason))
	})
	return out
}

func (s *Service) projectUsage(ctx context.Context, in *projectUsageInput) (*projectUsageOutput, error) {
	t, ok := authz.TargetFromContext(ctx)
	if !ok {
		return nil, identity.Err(identity.CodeUnauthenticated)
	}
	reader, ok := s.ingestStats.(UsageReader)
	if !ok || s.catalog == nil {
		return nil, huma.Error503ServiceUnavailable("ingest stats unavailable")
	}
	apps, err := s.catalog.ListProjectApps(ctx, t.ProjectID)
	if err != nil {
		return nil, internalError("project apps", err)
	}
	n := min(max(in.Days, 1), ingest.StatsRetentionDays)
	today := s.now().UTC().Truncate(24 * time.Hour)
	days := make([]time.Time, n)
	for i := range days {
		days[i] = today.AddDate(0, 0, i-n+1)
	}
	bytes, err := reader.ProjectBytes(ctx, t.ProjectID, days)
	if err == nil && len(bytes) != n {
		err = fmt.Errorf("got %d days of bytes, want %d", len(bytes), n)
	}
	if err != nil {
		return nil, internalError("project usage", err)
	}

	daily := make([]usageSum, n)
	var total usageSum
	var quotaRejectedToday int64
	envs := map[string]int64{}
	out := &projectUsageOutput{Body: ProjectUsage{Project: in.Project, Days: n, Apps: make([]AppUsageTotals, 0, len(apps))}}
	for _, app := range apps {
		usage, err := reader.AppUsage(ctx, app.ID, days)
		if err == nil && len(usage) != n {
			err = fmt.Errorf("got %d days, want %d", len(usage), n)
		}
		if err != nil {
			return nil, internalError("project usage", err)
		}
		var appSum usageSum
		for i, u := range usage {
			daily[i].add(u)
			appSum.add(u)
			total.add(u)
			for env, k := range u.Environments {
				envs[env] += k
			}
		}
		last := usage[n-1].RejectedBy
		quotaRejectedToday += last[ingest.ReasonRecordsPerMinute] + last[ingest.ReasonBytesPerDay]
		out.Body.Apps = append(out.Body.Apps, AppUsageTotals{AppID: app.ID.String(), App: app.Slug, UsageCounts: appSum.counts()})
	}
	slices.SortStableFunc(out.Body.Apps, func(a, b AppUsageTotals) int { return cmp.Compare(b.Accepted, a.Accepted) })

	out.Body.Totals = total.counts()
	out.Body.Daily = make([]UsageDay, n)
	for i, d := range daily {
		out.Body.Daily[i] = UsageDay{Date: days[i].Format(time.DateOnly), UsageCounts: d.counts(), Bytes: bytes[i]}
		out.Body.Bytes += bytes[i]
	}
	out.Body.Environments = make([]EnvironmentUsage, 0, len(envs))
	for env, k := range envs {
		out.Body.Environments = append(out.Body.Environments, EnvironmentUsage{Environment: env, Accepted: k})
	}
	slices.SortFunc(out.Body.Environments, func(a, b EnvironmentUsage) int {
		return cmp.Or(cmp.Compare(b.Accepted, a.Accepted), cmp.Compare(a.Environment, b.Environment))
	})

	q := QuotaUsage{IngestQuota: s.quota, BytesToday: bytes[n-1], RejectedToday: quotaRejectedToday}
	if s.quota.BytesPerDay > 0 {
		r := float64(q.BytesToday) / float64(s.quota.BytesPerDay)
		q.BytesTodayRatio = &r
	}
	out.Body.Quota = q
	return out, nil
}
