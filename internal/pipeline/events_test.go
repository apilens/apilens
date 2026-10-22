package pipeline

import (
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
		Release: "v1", ConsumerID: "user-1",
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
	if got != row {
		t.Fatalf("round trip changed the row:\n got %+v\nwant %+v", got, row)
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
