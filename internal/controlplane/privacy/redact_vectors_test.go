package privacy

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"testing"
)

var updateVectors = flag.Bool("update", false, "rewrite the wants of testdata/redact_vectors.json from this redactor")

// vectorsFile is shared with the UI's live tester (apps/ui/src/lib/privacy-redact.test.ts):
// both implementations must turn every `in` into its `want`.
const vectorsFile = "testdata/redact_vectors.json"

type vectorPolicy struct {
	MaskQueryParams []string `json:"mask_query_params"`
	MaskHeaders     []string `json:"mask_headers"`
	MaskBodyFields  []string `json:"mask_body_fields"`
}

type vector struct {
	Name   string       `json:"name"`
	Policy vectorPolicy `json:"policy"`
	Op     string       `json:"op"` // raw_path, headers, body or text
	In     string       `json:"in"`
	Want   string       `json:"want"`
}

type vectorsDoc struct {
	Comment string   `json:"_comment"`
	Vectors []vector `json:"vectors"`
}

func (v vector) run(t *testing.T) string {
	t.Helper()
	r, err := Compile(Policy{QueryParams: v.Policy.MaskQueryParams, Headers: v.Policy.MaskHeaders, BodyFields: v.Policy.MaskBodyFields})
	if err != nil {
		t.Fatalf("%s: compile: %v", v.Name, err)
	}
	switch v.Op {
	case "raw_path":
		return r.RawPath(v.In)
	case "headers":
		return r.Headers(v.In)
	case "body":
		return r.Body(v.In)
	case "text":
		return r.Text(v.In)
	}
	t.Fatalf("%s: unknown op %q", v.Name, v.Op)
	return ""
}

// TestRedactVectors checks the redactor against the vectors the UI's tester
// port is checked against too. Run with -update after changing the redactor
// (then make the UI port agree).
func TestRedactVectors(t *testing.T) {
	raw, err := os.ReadFile(vectorsFile)
	if err != nil {
		t.Fatal(err)
	}
	var doc vectorsDoc
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Vectors) == 0 {
		t.Fatal("no vectors")
	}
	for i, v := range doc.Vectors {
		got := v.run(t)
		if *updateVectors {
			doc.Vectors[i].Want = got
			continue
		}
		if got != v.Want {
			t.Errorf("%s: %s(%q)\n got %q\nwant %q", v.Name, v.Op, v.In, got, v.Want)
		}
	}
	if *updateVectors {
		var out bytes.Buffer
		enc := json.NewEncoder(&out)
		enc.SetEscapeHTML(false)
		enc.SetIndent("", "  ")
		if err := enc.Encode(doc); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(vectorsFile, out.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}
