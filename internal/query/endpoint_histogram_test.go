package query

import (
	"fmt"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// The bucket edges documented in the OpenAPI spec must match the edges the
// queries use.
func TestHistogramEdgesAreDocumented(t *testing.T) {
	documented := func(v any, field string) string {
		t.Helper()
		f, ok := reflect.TypeOf(v).FieldByName(field)
		if !ok {
			t.Fatalf("no field %s", field)
		}
		return f.Tag.Get("doc")
	}
	listed := func(n int, edge func(int) any) string {
		parts := []string{"0"}
		for i := range n {
			parts = append(parts, fmt.Sprint(edge(i)))
		}
		return strings.Join(append(parts, "+inf"), ", ")
	}
	lat := listed(len(latencyEdgesMs), func(i int) any { return latencyEdgesMs[i] })
	size := listed(len(sizeEdgesBytes), func(i int) any { return sizeEdgesBytes[i] })

	d := documented(endpointLatencyOutput{}.Body, "Histogram")
	if !strings.Contains(d, lat) || !strings.Contains(d, fmt.Sprintf("always %d ", len(latencyEdgesMs)+1)) {
		t.Errorf("latency histogram doc %q does not list edges %s", d, lat)
	}
	for _, f := range []string{"RequestSizeHistogram", "ResponseSizeHistogram"} {
		d := documented(endpointTransferOutput{}.Body, f)
		if !strings.Contains(d, size) || !strings.Contains(d, fmt.Sprintf("always %d ", len(sizeEdgesBytes)+1)) {
			t.Errorf("%s doc %q does not list edges %s", f, d, size)
		}
	}
	if !slices.IsSorted(latencyEdgesMs) || !slices.IsSorted(sizeEdgesBytes) {
		t.Error("histogram edges must be ascending")
	}
}

func TestBucketIndexExpression(t *testing.T) {
	if got, want := bucketIndex("request_size", []uint64{1, 256}),
		"toUInt64(arrayCount(e -> e <= request_size, [1, 256]))"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
	if got, want := bucketIndex("response_time_ms", []float64{1, 2.5}),
		"toUInt64(arrayCount(e -> e <= response_time_ms, [1, 2.5]))"; got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestSizeBucketsCoverEveryEdge(t *testing.T) {
	counts := make([]uint64, len(sizeEdgesBytes)+1)
	counts[0], counts[len(counts)-1] = 3, 1
	b := sizeBuckets(counts)
	if len(b) != len(sizeEdgesBytes)+1 || b[0].FromBytes != 0 || *b[0].ToBytes != 1 || b[0].Count != 3 {
		t.Fatalf("first bucket %+v", b[0])
	}
	last := b[len(b)-1]
	if last.ToBytes != nil || last.FromBytes != 4<<20 || last.Count != 1 {
		t.Fatalf("last bucket %+v", last)
	}
	for i := 1; i < len(b); i++ {
		if b[i].FromBytes != *b[i-1].ToBytes {
			t.Fatalf("gap between bucket %d and %d", i-1, i)
		}
	}
}
