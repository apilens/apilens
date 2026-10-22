// Package otel configures APILens's own tracing. Telemetry about APILens is
// exported over OTLP/HTTP (ideally into an APILens instance — dogfooding)
// and is off unless an endpoint is configured.
package otel

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.39.0"

	"github.com/apilens/apilens/internal/platform/buildinfo"
	"github.com/apilens/apilens/internal/platform/config"
)

// Setup installs a global tracer provider. It returns a shutdown func and a
// handler wrapper; both are no-ops when tracing is disabled.
func Setup(ctx context.Context, cfg config.OTelConfig) (shutdown func(context.Context) error, wrap func(http.Handler) http.Handler, err error) {
	noop := func(context.Context) error { return nil }
	if cfg.Endpoint == "" {
		return noop, nil, nil
	}
	opts := []otlptracehttp.Option{otlptracehttp.WithEndpointURL(cfg.Endpoint)}
	if cfg.Insecure {
		opts = append(opts, otlptracehttp.WithInsecure())
	}
	exp, err := otlptracehttp.New(ctx, opts...)
	if err != nil {
		return noop, nil, fmt.Errorf("otel: exporter: %w", err)
	}
	// resource.New (not Merge with resource.Default) avoids schema-URL
	// conflicts between the SDK's and our semconv versions.
	res, err := resource.New(ctx,
		resource.WithFromEnv(),
		resource.WithTelemetrySDK(),
		resource.WithAttributes(
			semconv.ServiceName(cfg.ServiceName),
			semconv.ServiceVersion(buildinfo.Get().Version),
		),
	)
	if err != nil {
		return noop, nil, fmt.Errorf("otel: resource: %w", err)
	}
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exp),
		sdktrace.WithResource(res),
		sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.TraceIDRatioBased(cfg.SampleRatio))),
	)
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{}))

	wrap = func(h http.Handler) http.Handler {
		return otelhttp.NewHandler(h, "apilens",
			otelhttp.WithFilter(func(r *http.Request) bool {
				p := r.URL.Path
				return p != "/livez" && p != "/readyz" && p != "/metrics" && !strings.HasPrefix(p, "/debug/")
			}),
			otelhttp.WithSpanNameFormatter(func(_ string, r *http.Request) string {
				if r.Pattern != "" {
					return r.Pattern
				}
				return r.Method + " unmatched"
			}),
		)
	}
	return tp.Shutdown, wrap, nil
}
