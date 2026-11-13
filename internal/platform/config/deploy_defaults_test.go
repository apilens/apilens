package config

import (
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"testing"
)

// deployKeys are the settings the self-host deployments (compose.yaml and
// the Helm values) set explicitly with the binary's defaults (#827).
var deployKeys = []string{
	"APILENS_IDENTITY__SENSITIVE_ACTION_MAX_AGE",
	"APILENS_PROJECT__DELETION_GRACE",
	"APILENS_ACCESS__MAX_DIRECT_MEMBERS_PER_PROJECT",
	"APILENS_INGEST__MAX_KEYS_PER_PROJECT",
	"APILENS_INGEST__RECORD_KEY_IP",
	"APILENS_AUDIT__RETENTION",
	"APILENS_RETENTION__REQUESTS",
	"APILENS_RETENTION__LOGS",
	"APILENS_RETENTION__SPANS",
	"APILENS_RETENTION__ROLLUPS_1M",
	"APILENS_RETENTION__ROLLUPS_1H",
}

// TestDeployDefaultsMatchBinary loads the config with the values compose.yaml
// and the Helm chart set for deployKeys and checks it equals the built-in
// defaults, so a default changed in one place is changed in all of them.
func TestDeployDefaultsMatchBinary(t *testing.T) {
	want, err := Load("", []string{kekEnv}, nil)
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join("..", "..", "..")
	sources := map[string]*regexp.Regexp{
		// APILENS_X: ${APILENS_X:-default}
		"deploy/compose/compose.yaml": regexp.MustCompile(`(?m)^\s+(APILENS_[A-Z0-9_]+): \$\{([A-Z0-9_]+):-([^}]*)\}\s*$`),
		// APILENS_X: value  (under `config:`)
		"deploy/helm/apilens/values.yaml": regexp.MustCompile(`(?m)^  (APILENS_[A-Z0-9_]+): (\S+)\s*$`),
	}
	for file, re := range sources {
		t.Run(file, func(t *testing.T) {
			src, err := os.ReadFile(filepath.Join(root, file))
			if err != nil {
				t.Fatal(err)
			}
			found := map[string]string{}
			for _, m := range re.FindAllStringSubmatch(string(src), -1) {
				if len(m) == 4 {
					if m[1] != m[2] {
						continue
					}
					found[m[1]] = m[3]
				} else {
					found[m[1]] = m[2]
				}
			}
			env := []string{kekEnv}
			for _, k := range deployKeys {
				v, ok := found[k]
				if !ok {
					t.Errorf("%s does not set %s", file, k)
					continue
				}
				env = append(env, k+"="+v)
			}
			got, err := Load("", env, nil)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Errorf("%s defaults differ from the binary's:\n got  %+v\n want %+v", file, got, want)
			}
		})
	}
}
