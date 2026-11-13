package config

import "fmt"

// Audit retention bounds, in days: the default (D7, #753) and the shortest
// period allowed. AuditKeepForever (0) never deletes events.
const (
	DefaultAuditRetention = 400
	MinAuditRetention     = 30
	AuditKeepForever      = 0
)

// AuditConfig configures the audit trail (audit.*).
type AuditConfig struct {
	// Retention is how many days audit events are kept (audit.retention): a
	// daily job deletes older ones. 0 keeps them forever; otherwise at least
	// MinAuditRetention.
	Retention int `koanf:"retention"`
}

func auditDefaults(m map[string]any) {
	m["audit.retention"] = DefaultAuditRetention
}

func (c *Config) validateAudit() []error {
	if d := c.Audit.Retention; d != AuditKeepForever && d < MinAuditRetention {
		return []error{fmt.Errorf("audit.retention %d: want 0 (keep forever) or at least %d days", d, MinAuditRetention)}
	}
	return nil
}
