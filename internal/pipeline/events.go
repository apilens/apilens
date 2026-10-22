package pipeline

import (
	"github.com/google/uuid"
	"google.golang.org/protobuf/types/known/timestamppb"

	eventv1 "github.com/apilens/apilens/internal/gen/pb/apilens/event/v1"
)

// Conversions between rows and the protobuf events carried by the Kafka sink
// (M3). Keeping them next to the rows makes schema drift a compile error.

// RequestEvent converts a row to its wire event.
func (r RequestRow) Event() *eventv1.RequestEvent {
	return &eventv1.RequestEvent{
		ProjectId: r.ProjectID.String(), AppId: r.AppID.String(), Environment: r.Environment,
		Timestamp: timestamppb.New(r.Timestamp), Method: r.Method, Path: r.Path, RawPath: r.RawPath,
		StatusCode: uint32(r.StatusCode), ResponseTimeMs: r.ResponseTimeMs, RequestSize: r.RequestSize,
		ResponseSize: r.ResponseSize, IpAddress: r.IPAddress, UserAgent: r.UserAgent, ConsumerId: r.ConsumerID,
		ConsumerName: r.ConsumerName, ConsumerGroup: r.ConsumerGroup, RequestPayload: r.RequestPayload,
		ResponsePayload: r.ResponsePayload, RequestHeaders: r.RequestHeaders, ResponseHeaders: r.ResponseHeaders,
		BaseUrl: r.BaseURL, TraceId: r.TraceID, SpanId: r.SpanID, Release: r.Release, Commit: r.Commit,
	}
}

// RequestRowFromEvent converts a wire event back to a row.
func RequestRowFromEvent(e *eventv1.RequestEvent) (RequestRow, error) {
	pid, aid, err := ids(e.GetProjectId(), e.GetAppId())
	if err != nil {
		return RequestRow{}, err
	}
	return RequestRow{
		ProjectID: pid, AppID: aid, Environment: e.GetEnvironment(), Timestamp: e.GetTimestamp().AsTime(),
		Method: e.GetMethod(), Path: e.GetPath(), RawPath: e.GetRawPath(), StatusCode: statusCode(e.GetStatusCode()),
		ResponseTimeMs: e.GetResponseTimeMs(), RequestSize: e.GetRequestSize(), ResponseSize: e.GetResponseSize(),
		IPAddress: e.GetIpAddress(), UserAgent: e.GetUserAgent(), ConsumerID: e.GetConsumerId(),
		ConsumerName: e.GetConsumerName(), ConsumerGroup: e.GetConsumerGroup(), RequestPayload: e.GetRequestPayload(),
		ResponsePayload: e.GetResponsePayload(), RequestHeaders: e.GetRequestHeaders(), ResponseHeaders: e.GetResponseHeaders(),
		BaseURL: e.GetBaseUrl(), TraceID: e.GetTraceId(), SpanID: e.GetSpanId(), Release: e.GetRelease(), Commit: e.GetCommit(),
	}, nil
}

// Event converts a log row to its wire event.
func (r LogRow) Event() *eventv1.LogEvent {
	return &eventv1.LogEvent{
		ProjectId: r.ProjectID.String(), AppId: r.AppID.String(), Environment: r.Environment,
		Timestamp: timestamppb.New(r.Timestamp), Level: r.Level, Message: r.Message, LoggerName: r.LoggerName,
		EndpointMethod: r.EndpointMethod, EndpointPath: r.EndpointPath, StatusCode: uint32(r.StatusCode),
		ConsumerId: r.ConsumerID, ConsumerName: r.ConsumerName, ConsumerGroup: r.ConsumerGroup,
		TraceId: r.TraceID, SpanId: r.SpanID, Payload: r.Payload, Attributes: r.Attributes,
		Release: r.Release, Commit: r.Commit,
	}
}

// Event converts a span row to its wire event.
func (r SpanRow) Event() *eventv1.SpanEvent {
	return &eventv1.SpanEvent{
		ProjectId: r.ProjectID.String(), AppId: r.AppID.String(), Environment: r.Environment,
		Timestamp: timestamppb.New(r.Timestamp), TraceId: r.TraceID, SpanId: r.SpanID, ParentSpanId: r.ParentSpanID,
		Name: r.Name, Kind: r.Kind, ServiceName: r.ServiceName, DurationMs: r.DurationMs, Status: r.Status,
		StatusCode: uint32(r.StatusCode), Attributes: r.Attributes, Release: r.Release, Commit: r.Commit,
	}
}

// Event converts a deploy row to its wire event. Project-wide deploys carry
// an empty app_id.
func (r DeployRow) Event() *eventv1.DeployEvent {
	app := ""
	if r.AppID != uuid.Nil {
		app = r.AppID.String()
	}
	return &eventv1.DeployEvent{
		ProjectId: r.ProjectID.String(), AppId: app, Environment: r.Environment, Release: r.Release,
		Commit: r.Commit, Url: r.URL, DeployedAt: timestamppb.New(r.DeployedAt),
	}
}

func statusCode(code uint32) uint16 {
	if code > 999 {
		return 0
	}
	return uint16(code)
}

func ids(project, app string) (uuid.UUID, uuid.UUID, error) {
	pid, err := uuid.Parse(project)
	if err != nil {
		return uuid.Nil, uuid.Nil, err
	}
	aid := uuid.Nil
	if app != "" {
		if aid, err = uuid.Parse(app); err != nil {
			return uuid.Nil, uuid.Nil, err
		}
	}
	return pid, aid, nil
}
