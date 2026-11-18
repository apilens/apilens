package pipeline

import (
	"testing"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2/lib/column"
)

// The values the span inserter appends for events and links must be
// accepted by the driver's columns of the api_spans types (migration 00004),
// with and without events.
func TestSpanEventAndLinkColumnsAcceptRowValues(t *testing.T) {
	newCol := func(name, chType string) column.Interface {
		t.Helper()
		col, err := column.Type(chType).Column(name, &column.ServerContext{Timezone: time.UTC})
		if err != nil {
			t.Fatalf("%s %s: %v", name, chType, err)
		}
		return col
	}
	cols := []column.Interface{
		newCol("events.time", "Array(DateTime64(9, 'UTC'))"),
		newCol("events.name", "Array(LowCardinality(String))"),
		newCol("events.attributes", "Array(Map(LowCardinality(String), String))"),
		newCol("links", "Array(Tuple(trace_id String, span_id String))"),
	}
	rows := []SpanRow{
		{},
		{
			Events: []SpanEventRow{
				{Time: time.Now(), Name: "exception", Attributes: map[string]string{"exception.type": "ValueError"}},
				{Time: time.Now(), Name: "retry"},
			},
			Links: []SpanLink{{TraceID: "5bf92f3577b34da6a3ce929d0e0e4736", SpanID: "10f067aa0ba902b7"}},
		},
	}
	for i, r := range rows {
		times, names, attrs := spanEventColumns(r.Events)
		for j, v := range []any{times, names, attrs, nonNilLinks(r.Links)} {
			if err := cols[j].AppendRow(v); err != nil {
				t.Fatalf("row %d, column %s: %v", i, cols[j].Name(), err)
			}
		}
	}
	for _, c := range cols {
		if c.Rows() != len(rows) {
			t.Errorf("%s has %d rows, want %d", c.Name(), c.Rows(), len(rows))
		}
	}
}
