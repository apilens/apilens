package query

import (
	"context"
	"encoding/json"
	"net/url"

	"github.com/google/uuid"

	"github.com/apilens/apilens/internal/authz"
	"github.com/apilens/apilens/internal/controlplane/store/db"
	"github.com/apilens/apilens/internal/identity/audit"
	"github.com/apilens/apilens/internal/platform/authn"
)

// Auditor records audit events; *audit.Recorder satisfies it. The query
// role only writes audit events, through the identity recorder (ADR 0005);
// it never reads audit tables.
type Auditor interface {
	Record(ctx context.Context, e audit.Event) error
}

type auditDeps struct {
	pool AlertPool
	rec  Auditor
}

// WithAudit records the alert rule, notification channel, health check, app
// settings and endpoint settings changes made through the API, each in the
// transaction of the change on pool. Without it changes are not audited.
func (s *Service) WithAudit(pool AlertPool, rec Auditor) *Service {
	s.audit = &auditDeps{pool: pool, rec: rec}
	return s
}

// audited runs write and records the event it returns (nil: nothing
// changed) in the same transaction. Without WithAudit it runs write on plain
// outside a transaction and records nothing. The event's user, actor, org
// and project are filled from the signed-in user and the project target.
func audited[S any](ctx context.Context, s *Service, target authz.Target, plain S, inTx func(*db.Queries) S,
	write func(S) (*audit.Event, error),
) error {
	if s.audit == nil {
		_, err := write(plain)
		return err
	}
	tx, err := s.audit.pool.Begin(ctx)
	if err != nil {
		return internalError("begin", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	ev, err := write(inTx(db.New(tx)))
	if err != nil {
		return err
	}
	if ev != nil {
		if p, ok := authn.FromContext(ctx); ok && p.Kind == authn.KindUser {
			user := p.UserID
			ev.User, ev.Actor = &user, &user
		}
		org, project := target.OrgID, target.ProjectID
		ev.Org, ev.Project = &org, &project
		if err := s.audit.rec.Record(audit.WithTx(ctx, tx), *ev); err != nil {
			return internalError("audit", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return internalError("commit", err)
	}
	return nil
}

// alertTarget is the project the guard authorized the request for.
func alertTarget(ctx context.Context) authz.Target {
	t, _ := authz.TargetFromContext(ctx)
	return t
}

func queries(q *db.Queries) *db.Queries { return q }

// jsonValues is v encoded as JSON and decoded as an object, without the
// keys in drop (ids and timestamps that are not settings).
func jsonValues(v any, drop ...string) map[string]any {
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	var m map[string]any
	if json.Unmarshal(b, &m) != nil {
		return nil
	}
	for _, k := range drop {
		delete(m, k)
	}
	return m
}

// ruleValues are the settings of a rule as its audit changes record them.
func ruleValues(r db.AlertRule) map[string]any {
	return jsonValues(toAlertRule(r, nil), "id", "state", "created_by", "created_at", "updated_at")
}

// channelValues are the type and name of a channel; never its config, which
// holds secrets (a webhook URL is a bearer secret).
func channelValues(c db.NotificationChannel) map[string]any {
	return map[string]any{"type": c.Type, "name": c.Name}
}

// healthCheckValues are the settings of a check as its audit changes record
// them. The URL loses its user info, query and fragment, which may carry
// credentials.
func healthCheckValues(h db.HealthCheck) map[string]any {
	return map[string]any{
		"app_id": h.AppID.String(), "environment": h.Environment, "url": safeURL(h.Url),
		"expected_status": h.ExpectedStatus, "enabled": h.Enabled,
	}
}

func safeURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	u.User, u.RawQuery, u.ForceQuery, u.Fragment, u.RawFragment = nil, "", false, "", ""
	return u.String()
}

func ruleTarget(r db.AlertRule) audit.Target {
	return audit.Target{Type: "alert_rule", ID: r.ID.String(), Label: r.Name}
}

func channelTarget(c db.NotificationChannel) audit.Target {
	return audit.Target{Type: "alert_channel", ID: c.ID.String(), Label: c.Name}
}

func healthCheckTarget(h db.HealthCheck) audit.Target {
	return audit.Target{Type: "health_check", ID: h.ID.String(), Label: safeURL(h.Url)}
}

func settingsAppTarget(id uuid.UUID, slug string) audit.Target {
	return audit.Target{Type: "app", ID: id.String(), Label: slug}
}
