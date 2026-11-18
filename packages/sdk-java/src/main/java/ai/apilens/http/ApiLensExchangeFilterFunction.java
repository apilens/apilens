package ai.apilens.http;

import ai.apilens.TraceContext;
import java.util.concurrent.CancellationException;
import org.springframework.web.reactive.function.client.ClientRequest;
import org.springframework.web.reactive.function.client.ClientResponse;
import org.springframework.web.reactive.function.client.ExchangeFilterFunction;
import org.springframework.web.reactive.function.client.ExchangeFunction;
import reactor.core.publisher.Mono;

/**
 * Child {@code http} spans and {@code traceparent} propagation for {@code WebClient}. The trace is
 * read from the Reactor context the API Lens WebFilter writes, or from the calling thread when the
 * call is subscribed inside a servlet request. Spring Boot adds it to the auto-configured {@code
 * WebClient.Builder}.
 */
public final class ApiLensExchangeFilterFunction implements ExchangeFilterFunction {
  private final ApiLensHttpTracing tracing;

  public ApiLensExchangeFilterFunction(ApiLensHttpTracing tracing) {
    this.tracing = tracing;
  }

  @Override
  public Mono<ClientResponse> filter(ClientRequest request, ExchangeFunction next) {
    return Mono.deferContextual(context -> {
      TraceContext trace = context.<TraceContext>getOrEmpty(TraceContext.class)
          .orElseGet(TraceContext::current);
      ApiLensHttpTracing.OutboundSpan span = tracing.start(trace, request.method().name(), request.url());
      if (span == null) {
        return next.exchange(request);
      }
      ClientRequest traced = request.headers().containsKey("traceparent")
          ? request
          : ClientRequest.from(request).header("traceparent", span.traceparent()).build();
      return next.exchange(traced)
          .doOnNext(response -> span.end(response.statusCode().value(), null))
          .doOnError(error -> span.end(0, error))
          // Cancelled before a response (e.g. a timeout upstream): record it as failed.
          .doOnCancel(() -> span.end(0, new CancellationException()));
    });
  }
}
