package config

import (
	"fmt"
	"time"
)

// DefaultProjectDeletionGrace is how long a deleted project can be restored
// before the purge job removes its data (D8 in #753).
const DefaultProjectDeletionGrace = 7 * 24 * time.Hour

// ProjectConfig configures the project lifecycle (project.*).
type ProjectConfig struct {
	// DeletionGrace is how long a deleted project stays restorable
	// (project.deletion_grace): delete sets purge_after = now + this.
	// 0 schedules the purge at once (no restore window).
	DeletionGrace time.Duration `koanf:"deletion_grace"`
}

func projectDefaults(m map[string]any) {
	m["project.deletion_grace"] = DefaultProjectDeletionGrace.String()
}

func (c *Config) validateProject() []error {
	if c.Project.DeletionGrace < 0 {
		return []error{fmt.Errorf("project.deletion_grace %s: want 0 (immediate) or more", c.Project.DeletionGrace)}
	}
	return nil
}
