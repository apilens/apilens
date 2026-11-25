package pipeline

import (
	"reflect"
	"testing"
	"time"

	"github.com/google/uuid"
	"google.golang.org/protobuf/proto"

	eventv1 "github.com/apilens/apilens/internal/gen/pb/apilens/event/v1"
)

func TestRequestEventRoundTrip(t *testing.T) {
	row := RequestRow{
		ProjectID: uuid.New(), AppID: uuid.New(), Environment: "production",
		Timestamp: time.Date(2026, 10, 22, 10, 0, 0, 123_000_000, time.UTC), Method: "GET", Path: "/orders/{id}",
		StatusCode: 503, ResponseTimeMs: 12.5, RequestSize: 10, ResponseSize: 20, TraceID: "4bf92f3577b34da6a3ce929d0e0e4736",
		Release: "v1", ConsumerID: "user-1", Sampled: true, Attributes: map[string]string{"tenant.id": "acme"},
		ValidationErrors: []ValidationError{{Loc: "body.email", Msg: "field required", Type: "missing"}},
		InstanceID:       "4b0c7a8e-2f0d-4c1e-9a55-0d6f3b1f1a9e",
	}
	b, err := proto.Marshal(&eventv1.RequestBatch{Events: []*eventv1.RequestEvent{row.Event()}})
	if err != nil {
		t.Fatal(err)
	}
	var batch eventv1.RequestBatch
	if err := proto.Unmarshal(b, &batch); err != nil {
		t.Fatal(err)
	}
	got, err := RequestRowFromEvent(batch.GetEvents()[0])
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, row) {
		t.Fatalf("round trip changed the row:\n got %+v\nwant %+v", got, row)
	}

	row.Sampled = false
	if got, _ := RequestRowFromEvent(row.Event()); got.Sampled {
		t.Fatal("sampled=false lost in the event")
	}
}

func TestRequestEventWithoutSampledIsSampled(t *testing.T) {
	// Events from producers that predate the field leave it unset.
	got, err := RequestRowFromEvent(&eventv1.RequestEvent{ProjectId: uuid.NewString(), AppId: uuid.NewString()})
	if err != nil {
		t.Fatal(err)
	}
	if !got.Sampled {
		t.Fatal("unset sampled should mean sampled in")
	}
}

func TestDeployEventProjectWide(t *testing.T) {
	ev := DeployRow{ProjectID: uuid.New(), Release: "v2", DeployedAt: time.Now()}.Event()
	if ev.GetAppId() != "" {
		t.Fatalf("project-wide deploy should have empty app_id, got %q", ev.GetAppId())
	}
	if _, _, err := ids(ev.GetProjectId(), ev.GetAppId()); err != nil {
		t.Fatal(err)
	}
}

func TestSpanEventCarriesStatusMessageEventsLinks(t *testing.T) {
	at := time.Date(2026, 10, 22, 10, 0, 0, 5, time.UTC)
	ev := SpanRow{
		ProjectID: uuid.New(), Timestamp: at, StatusMessage: "card declined",
		Events: []SpanEventRow{{Time: at, Name: "exception", Attributes: map[string]string{"exception.type": "ValueError"}}},
		Links:  []SpanLink{{TraceID: "5bf92f3577b34da6a3ce929d0e0e4736", SpanID: "10f067aa0ba902b7"}},
	}.Event()
	b, err := proto.Marshal(&eventv1.SpanBatch{Events: []*eventv1.SpanEvent{ev}})
	if err != nil {
		t.Fatal(err)
	}
	var batch eventv1.SpanBatch
	if err := proto.Unmarshal(b, &batch); err != nil {
		t.Fatal(err)
	}
	got := batch.GetEvents()[0]
	if got.GetStatusMessage() != "card declined" || len(got.GetEvents()) != 1 {
		t.Fatalf("span event = %v", got)
	}
	if e := got.GetEvents()[0]; e.GetName() != "exception" || !e.GetTime().AsTime().Equal(at) ||
		e.GetAttributes()["exception.type"] != "ValueError" {
		t.Errorf("event = %v", e)
	}
	if l := got.GetLinks(); len(l) != 1 || l[0].GetTraceId() != "5bf92f3577b34da6a3ce929d0e0e4736" || l[0].GetSpanId() != "10f067aa0ba902b7" {
		t.Errorf("links = %v", l)
	}
}
